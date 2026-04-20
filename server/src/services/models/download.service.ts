// URL handling + validation helpers for model downloads.
//
// No network side effects: everything here is pure URL manipulation. The
// actual downloading flows through `downloadController.service.ts`.

import fs from 'fs';
import path from 'path';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { safeResolve } from '../../lib/fs.js';
import * as liveSettings from '../systemLauncher/liveSettings.js';

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

function buildFallbackUrl(modelInfo: CatalogModelEntry, source: string): string {
  const baseUrl = source === 'hf' ? 'https://huggingface.co/' : 'https://hf-mirror.com/';
  const repo = `models/${modelInfo.name}`;
  const filename = modelInfo.filename || modelInfo.name;
  return `${baseUrl}${repo}/resolve/main/${filename}`;
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
  if (!raw) return [{ url: buildDownloadUrl(modelInfo, source), source }];
  const primarySrc = source === 'mirror' ? 'mirror' : 'hf';
  const primaryUrl = source === 'mirror' ? raw.mirror : raw.hf;
  if (primaryUrl) out.push({ url: primaryUrl, source: primarySrc });
  if (raw.cdn) out.push({ url: raw.cdn, source: 'cdn' });
  const altSrc = source === 'mirror' ? 'hf' : 'mirror';
  const altUrl = source === 'mirror' ? raw.hf : raw.mirror;
  if (altUrl && altUrl !== primaryUrl) out.push({ url: altUrl, source: altSrc });
  return out;
}

/** Replace `huggingface.co` with a user-configured mirror endpoint. */
export function processHfEndpoint(
  downloadUrl: string,
  hfEndpoint: string = liveSettings.getHfEndpoint(),
): string {
  if (hfEndpoint && downloadUrl.includes('huggingface.co')) {
    logger.info('download HF endpoint override applied', { endpoint: hfEndpoint });
    return downloadUrl.replace('huggingface.co/', hfEndpoint.replace(/^https?:\/\//, ''));
  }
  return downloadUrl;
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

/** Replace `/blob/` with `/resolve/` in HF URLs. */
export function buildResolveUrl(hfUrl: string): string {
  const resolved = hfUrl.replace('/blob/', '/resolve/');
  if (resolved === hfUrl) logger.info('download URL already in resolve form');
  return resolved;
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
