// URL handling + validation helpers for model downloads.
//
// No network side effects: everything here is pure URL manipulation. The
// actual downloading flows through `downloadController.service.ts`.
//
// Catalog → URL builders moved to `download.urlBuild.ts`; re-exported here
// so existing call sites keep working.

import fs from 'fs';
import path from 'path';
import { env } from '../../config/env.js';
import { safeResolve } from '../../lib/fs.js';

export {
  buildDownloadUrl, getAllDownloadUrls, processHfEndpoint, buildResolveUrl,
} from './download.urlBuild.js';
export type { CatalogModelEntry } from './download.urlBuild.js';

/** Models directory category -> subdir mapping (matches launcher exactly). */
export function getModelSaveDir(modelType: string): string {
  switch (modelType) {
    case 'checkpoint': return 'models/checkpoints';
    case 'lora': return 'models/loras';
    case 'vae': return 'models/vae';
    case 'controlnet': return 'models/controlnet';
    case 'upscaler': return 'models/upscale_models';
    case 'embedding': return 'models/embeddings';
    case 'inpaint': return 'models/inpaint';
    default: return 'models/checkpoints';
  }
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

/** Validate a HF URL provided by a user. Returns a parsed filename on success. */
export function validateHfUrl(
  hfUrl: string,
): { isValid: boolean; fileName: string; error?: string } {
  try {
    const url = new URL(hfUrl);
    if (!url.hostname.includes('huggingface.co') && !url.hostname.includes('hf-mirror.com')) {
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
 * Validate a GitHub release URL of the form
 * `github.com/<owner>/<repo>/releases/download/<tag>/<file>`. The release
 * URL DOES encode the filename in its last segment, so we can derive it
 * here for the unified download endpoint without forcing the caller to
 * supply a `filename` body field.
 */
export function validateGithubUrl(
  url: string,
): { isValid: boolean; fileName: string; error?: string } {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host !== 'github.com' && host !== 'www.github.com') {
      return { isValid: false, fileName: '', error: 'Only github.com URLs are supported' };
    }
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 6 || parts[2] !== 'releases' || parts[3] !== 'download') {
      return {
        isValid: false, fileName: '',
        error: 'GitHub URL must target /releases/download/:tag/:file',
      };
    }
    const fileName = decodeURIComponent(parts[parts.length - 1]);
    return { isValid: true, fileName };
  } catch {
    return { isValid: false, fileName: '', error: 'Invalid URL format' };
  }
}

/**
 * Last-resort validator for an arbitrary http(s) URL on an allow-listed
 * host. The caller has already checked the allow-list (see
 * `services/models/downloadAllowlist.ts`); this only confirms the URL
 * itself is well-formed and not a non-http scheme.
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
 * Validate a CivitAI download URL. The public download endpoint is
 * `https://civitai.com/api/download/models/:versionId` — it 302-redirects
 * to the actual file. We accept `civitai.com` + `www.civitai.com`.
 *
 * Civitai does not put the real filename in the URL; the redirect exposes it
 * via `Content-Disposition`. Callers that need the filename up-front should
 * resolve the version via the civitai service and pass `modelName`/`filename`
 * on the download request. Here we only confirm the URL is well-formed and on
 * the allowed host.
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
  if (host === 'github.com' || host === 'www.github.com') {
    return 'github';
  }
  // Any other valid http(s) URL becomes the generic streamer's responsibility.
  // Allow-list enforcement happens at the route layer (see
  // `services/models/downloadAllowlist.ts`); this branch only supplies the
  // host family for the unified-download dispatcher.
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
  // Don't use safeResolve directly with filename - it might include slashes.
  return path.join(env.COMFYUI_PATH, saveDir, filename);
}
