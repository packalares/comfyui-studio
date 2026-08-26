// URL helpers for model downloads: validation, building, allow-list.
// No network side effects — pure URL manipulation.

import fs from 'fs';
import path from 'path';
import { env } from '../../config/env.js';
import { safeResolve } from '../../lib/fs.js';
import { logger } from '../../lib/logger.js';
import * as liveSettings from '../settings/network.js';
import { hostIsPrivate, isHttpUrl } from '../../lib/security.js';
import { getModelTrustedHosts } from '../settings/network.js';
import { modelSaveDir } from './typeMap.js';

// ── Catalog entry type ──────────────────────────────────────────────────────

/** Catalog entry shape (matches launcher's info.ts ModelInfo record). */
export interface CatalogModelEntry {
  name: string;
  type?: string;
  base_url?: string;
  save_path: string;
  description?: string;
  reference?: string;
  filename?: string;
  sha256?: string;
  installed?: boolean;
  url?: string | { hf?: string; mirror?: string; cdn?: string };
  fileStatus?: 'complete' | 'incomplete' | 'corrupted' | 'unknown';
  fileSize?: number;
  size?: string;
  base?: string;
  hfRepo?: string;
}

// ── URL builders ─────────────────────────────────────────────────────────────

export class NoDownloadSourceError extends Error {
  modelName: string;
  constructor(modelName: string) {
    super(`No download URL available for ${modelName}. Add a URL in catalog or paste one manually.`);
    this.name = 'NoDownloadSourceError';
    this.modelName = modelName;
  }
}

/**
 * Build the preferred download URL. Honours `source` (hf | mirror | cdn).
 * If the catalog entry stores URL as a plain string, the `hf -> hf-mirror.com`
 * rewrite still applies for non-hf sources.
 */
export function buildDownloadUrl(
  modelInfo: CatalogModelEntry,
  source: string = 'hf',
): string {
  const raw = modelInfo.url;
  if (raw) {
    if (typeof raw === 'string') return rewriteStringUrl(raw, source);
    if (raw.hf || raw.mirror || raw.cdn) return pickFromUrlObject(raw, source);
    const first = Object.values(raw)[0];
    if (first) return first;
  }
  return buildFallbackUrl(modelInfo, source);
}

function rewriteStringUrl(url: string, source: string): string {
  if (source !== 'hf' && url.includes('huggingface.co')) {
    return url.replace('huggingface.co', 'hf-mirror.com');
  }
  return url;
}

function pickFromUrlObject(
  url: { hf?: string; mirror?: string; cdn?: string },
  source: string,
): string {
  if (source === 'cdn' && url.cdn) return url.cdn;
  if (source === 'mirror' && url.mirror) return url.mirror;
  if (url.hf) return url.hf;
  return url.mirror || url.cdn || '';
}

function buildFallbackUrl(_modelInfo: CatalogModelEntry, _source: string): string {
  // Fabricating a huggingface.co URL always 401s; return empty so the caller
  // refuses the install with a typed error instead of a silent failure.
  return '';
}

/**
 * All viable download URLs in launcher's priority order:
 *   user-chosen primary -> cdn fallback -> alternative primary.
 */
export function getAllDownloadUrls(
  modelInfo: CatalogModelEntry,
  source: string = 'hf',
): Array<{ url: string; source: string }> {
  const out: Array<{ url: string; source: string }> = [];
  const raw = modelInfo.url;
  if (typeof raw === 'string') return [{ url: raw, source: 'default' }];
  if (!raw) {
    const built = buildDownloadUrl(modelInfo, source);
    return built ? [{ url: built, source }] : [];
  }
  const primarySrc = source === 'mirror' ? 'mirror' : 'hf';
  const primaryUrl = source === 'mirror' ? raw.mirror : raw.hf;
  if (primaryUrl) out.push({ url: primaryUrl, source: primarySrc });
  if (raw.cdn) out.push({ url: raw.cdn, source: 'cdn' });
  const altSrc = source === 'mirror' ? 'hf' : 'mirror';
  const altUrl = source === 'mirror' ? raw.hf : raw.mirror;
  if (altUrl && altUrl !== primaryUrl) out.push({ url: altUrl, source: altSrc });
  return out;
}

/** Replace `huggingface.co` with a user-configured mirror endpoint.
 *  Strip the scheme AND any trailing slash from the endpoint, then rejoin
 *  with the expected `/` separator. Earlier the replacement read
 *  `huggingface.co/` → `<endpoint-no-scheme>` (no slash), producing
 *  `https://hf-mirror.comACE-Step/...` and 404ing every download. */
export function processHfEndpoint(
  downloadUrl: string,
  hfEndpoint: string = liveSettings.getHfEndpoint(),
): string {
  if (hfEndpoint && downloadUrl.includes('huggingface.co')) {
    const host = hfEndpoint.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    logger.info('download HF endpoint override applied', { endpoint: hfEndpoint });
    return downloadUrl.replace('huggingface.co/', host + '/');
  }
  return downloadUrl;
}

/** Replace `/blob/` with `/resolve/` in HF URLs. */
export function buildResolveUrl(hfUrl: string): string {
  const resolved = hfUrl.replace('/blob/', '/resolve/');
  if (resolved === hfUrl) logger.info('download URL already in resolve form');
  return resolved;
}

// ── Validators ───────────────────────────────────────────────────────────────

/** Validate a HF URL provided by a user. Returns a parsed filename on success. */
export function validateHfUrl(
  hfUrl: string,
): { isValid: boolean; fileName: string; error?: string } {
  try {
    const url = new URL(hfUrl);
    // Exact-host / dot-boundary suffix match — `.includes()` would accept
    // `huggingface.co.evil.com` and `evil-huggingface.co`.
    const host = url.hostname.toLowerCase();
    const hostAllowed = host === 'huggingface.co' || host.endsWith('.huggingface.co')
      || host === 'hf-mirror.com' || host.endsWith('.hf-mirror.com');
    if (!hostAllowed) {
      return { isValid: false, fileName: '', error: 'Only Hugging Face URLs are supported' };
    }
    const pathParts = url.pathname.split('/');
    if (pathParts.length < 5) {
      return { isValid: false, fileName: '', error: 'Invalid Hugging Face URL format' };
    }
    return { isValid: true, fileName: pathParts[pathParts.length - 1] };
  } catch {
    return { isValid: false, fileName: '', error: 'Invalid URL format' };
  }
}

/**
 * Validate a public GitHub content URL. Three accepted shapes:
 *   1. `github.com/<owner>/<repo>/releases/download/<tag>/<file>` — release asset
 *   2. `github.com/<owner>/<repo>/raw/<branch>/<path...>` — repo blob (302 to raw)
 *   3. `raw.githubusercontent.com/<owner>/<repo>/<branch>/<path...>` — direct raw
 */
export function validateGithubUrl(
  url: string,
): { isValid: boolean; fileName: string; error?: string } {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const parts = u.pathname.split('/').filter(Boolean);
    if (host === 'github.com' || host === 'www.github.com') {
      // Shape 1: /releases/download/:tag/:file
      if (parts.length >= 6 && parts[2] === 'releases' && parts[3] === 'download') {
        return { isValid: true, fileName: decodeURIComponent(parts[parts.length - 1]) };
      }
      // Shape 2: /:owner/:repo/raw/:branch/...path
      if (parts.length >= 5 && parts[2] === 'raw') {
        return { isValid: true, fileName: decodeURIComponent(parts[parts.length - 1]) };
      }
      return {
        isValid: false, fileName: '',
        error: 'GitHub URL must target /releases/download/:tag/:file or /:owner/:repo/raw/:branch/...',
      };
    }
    if (host === 'raw.githubusercontent.com') {
      if (parts.length >= 4) {
        return { isValid: true, fileName: decodeURIComponent(parts[parts.length - 1]) };
      }
      return { isValid: false, fileName: '', error: 'raw.githubusercontent.com URL is malformed' };
    }
    return { isValid: false, fileName: '', error: 'Only github.com / raw.githubusercontent.com URLs are supported' };
  } catch {
    return { isValid: false, fileName: '', error: 'Invalid URL format' };
  }
}

/** Rewrite `github.com/.../raw/<branch>/<path>` → `raw.githubusercontent.com/...`.
 *  Already-raw URLs and release URLs pass through unchanged. */
export function normaliseGithubUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host !== 'github.com' && host !== 'www.github.com') return url;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length >= 5 && parts[2] === 'raw') {
      const owner = parts[0];
      const repo = parts[1];
      const rest = parts.slice(3).map(encodeURIComponent).join('/');
      return `https://raw.githubusercontent.com/${owner}/${repo}/${rest}`;
    }
    return url;
  } catch {
    return url;
  }
}

/**
 * Last-resort validator for an arbitrary http(s) URL on an allow-listed host.
 * Only confirms well-formedness + http(s) scheme; allow-list check is separate.
 */
export function validateGenericUrl(
  url: string,
): { isValid: boolean; error?: string } {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { isValid: false, error: 'Only http(s) URLs are supported' };
    }
    return { isValid: true };
  } catch {
    return { isValid: false, error: 'Invalid URL format' };
  }
}

/**
 * Validate a CivitAI download URL.
 * Public endpoint: `https://civitai.com/api/download/models/:versionId`
 */
export function validateCivitaiUrl(
  url: string,
): { isValid: boolean; error?: string } {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host !== 'civitai.com' && host !== 'www.civitai.com') {
      return { isValid: false, error: 'Only civitai.com URLs are supported' };
    }
    if (!u.pathname.startsWith('/api/download/models/')) {
      return { isValid: false, error: 'CivitAI URL must target /api/download/models/:versionId' };
    }
    return { isValid: true };
  } catch {
    return { isValid: false, error: 'Invalid URL format' };
  }
}

/** Identify the upstream host family for a given download URL. */
export type DownloadHost = 'huggingface' | 'civitai' | 'github' | 'generic';

export function detectDownloadHost(url: string): DownloadHost | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase();
  if (host === 'huggingface.co' || host === 'www.huggingface.co' || host === 'hf-mirror.com') {
    return 'huggingface';
  }
  if (host === 'civitai.com' || host === 'www.civitai.com') {
    return 'civitai';
  }
  if (host === 'github.com' || host === 'www.github.com'
      || host === 'raw.githubusercontent.com') {
    return 'github';
  }
  // Allow-list enforcement is at the route layer; here we just supply the family.
  return 'generic';
}

/** Ensure the destination directory exists under the ComfyUI install root. */
export function ensureSaveDirectory(saveDir: string): string {
  const full = safeResolve(env.COMFYUI_PATH, saveDir);
  fs.mkdirSync(full, { recursive: true });
  return full;
}

/** Absolute output path under ComfyUI install root. */
export function resolveOutputPath(saveDir: string, filename: string): string {
  return path.join(env.COMFYUI_PATH, saveDir, filename);
}

/** Compose a `models/<subdir>` path from a raw subdir name (e.g. 'loras'). */
export function composeModelSaveDir(modelDir: string): string {
  return `models/${modelDir}`;
}

/** Models directory category -> subdir mapping. Delegates to typeMap so the
 *  server and UI always share the same table. */
export function getModelSaveDir(modelType: string): string {
  return modelSaveDir(modelType);
}

/** Infer a model's category from its filename. Matches launcher. */
export function inferModelType(modelName: string): string {
  const lower = modelName.toLowerCase();
  if (lower.endsWith('.safetensors') || lower.endsWith('.ckpt')) {
    if (lower.includes('lora')) return 'lora';
    if (lower.includes('inpaint')) return 'inpaint';
    if (lower.includes('controlnet')) return 'controlnet';
    return 'checkpoint';
  }
  if (lower.endsWith('.pth')) {
    if (lower.includes('upscale')) return 'upscaler';
    return 'vae';
  }
  if (lower.endsWith('.pt')) return 'embedding';
  return 'checkpoint';
}

// ── Allow-list ────────────────────────────────────────────────────────────────

// "Known-good" hosts that the operator explicitly trusts. Used today only as
// a documentation/audit signal — `validateAllowedUrl` accepts any non-private
// http(s) URL after the resolver has content-checked it at paste time. Future
// callers may differentiate (e.g. skip extra retry backoff for these hosts).
const BUILTIN_DOWNLOAD_HOSTS: ReadonlySet<string> = new Set([
  'huggingface.co', 'www.huggingface.co', 'hf-mirror.com',
  'civitai.com', 'www.civitai.com',
  'github.com', 'www.github.com',
  'drive.google.com', 'docs.google.com', 'drive.usercontent.google.com',
]);

/** Live read so operator-added hosts apply without restart. */
function liveAllowedHosts(): Set<string> {
  const out = new Set<string>(BUILTIN_DOWNLOAD_HOSTS);
  for (const h of getModelTrustedHosts()) out.add(h);
  return out;
}

export function isAllowedDownloadHost(url: string): boolean {
  try {
    return liveAllowedHosts().has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export interface AllowedUrlResult {
  ok: boolean;
  /** Error message suitable for a 400 response when ok=false. */
  error?: string;
}

/**
 * One-stop validator for the unified-download endpoint:
 *   - http(s) only.
 *   - Hostname not on the SSRF private-IP set.
 *
 * The host allow-list check was removed (2026-05) so the downloader and the
 * paste-URL resolver agree on which URLs are acceptable. Any URL that
 * passed `resolveGenericUrl`'s HEAD-probe at paste time has already been
 * content-checked as a binary model file from a public, non-private host —
 * gating again here was redundant and rejected legitimate downloads from
 * hosts the resolver accepted (Google Drive, raw.githubusercontent.com,
 * various ESRGAN/upscaler mirrors). The SSRF guard is the only real
 * security boundary here — the allow-list was just paperwork.
 */
export function validateAllowedUrl(url: string): AllowedUrlResult {
  if (!isHttpUrl(url)) return { ok: false, error: 'hfUrl must be http(s)' };
  if (hostIsPrivate(url)) return { ok: false, error: 'hfUrl points at a private/loopback host' };
  return { ok: true };
}

/**
 * Detect whether the URL is a civitai-style host that does not encode a
 * filename in its path. The route handler uses this to decide whether to
 * require an explicit `filename` body field.
 */
export function urlEncodesFilename(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host !== 'civitai.com' && host !== 'www.civitai.com';
  } catch {
    return false;
  }
}
