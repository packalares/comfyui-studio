// Catalog → download URL construction helpers.
//
// Split out of `download.service.ts` so that file stays under the 250-line
// cap once the github + generic + walker branches were added. These helpers
// existed long before urlSources[]; they are still used by the launcher's
// `installFromCatalog` flow which reads from the bundled model-list whose
// entries can ship either `url: string` or `url: { hf, mirror, cdn }`.

import { logger } from '../../lib/logger.js';
import * as liveSettings from '../systemLauncher/liveSettings.js';

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

/** Replace `/blob/` with `/resolve/` in HF URLs. */
export function buildResolveUrl(hfUrl: string): string {
  const resolved = hfUrl.replace('/blob/', '/resolve/');
  if (resolved === hfUrl) logger.info('download URL already in resolve form');
  return resolved;
}
