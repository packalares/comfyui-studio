// GitHub Release URL resolver.
//
// Accepts the canonical release-asset URL shapes:
//   - https://github.com/<owner>/<repo>/releases/download/<tag>/<file>
//   - https://github.com/<owner>/<repo>/releases/download/<tag>/<file>?token=...
//
// Probes file size via the public REST API
// (`GET /repos/<owner>/<repo>/releases/tags/<tag>`) so we don't need to
// follow the redirect to the signed S3 asset just to learn the byte count.
// The returned `downloadUrl` is the canonical github.com URL — the engine
// (and the walker on retry) re-resolves the signed CDN URL with a fresh GET
// because the signature is short-lived and would otherwise expire mid-retry.

import { logger } from '../../lib/logger.js';
import { getGithubAuthHeaders } from '../../lib/http.js';
import { getGithubToken } from '../settings.js';
import { guessFolder } from './resolveHuggingface.js';
import type { ResolvedModel, SuggestedFolder } from './resolveHuggingface.js';

interface ParsedGhRelease {
  owner: string;
  repo: string;
  tag: string;
  fileName: string;
  /** Canonical github.com download URL (always re-resolvable on retry). */
  canonicalUrl: string;
}

/** Public for tests. Returns null on any non-release github URL. */
export function parseGithubReleaseUrl(raw: string): ParsedGhRelease | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  const host = u.hostname.toLowerCase();
  if (host !== 'github.com' && host !== 'www.github.com') return null;
  const parts = u.pathname.split('/').filter((p) => p.length > 0);
  // <owner>/<repo>/releases/download/<tag>/<file...>
  if (parts.length < 6) return null;
  if (parts[2] !== 'releases' || parts[3] !== 'download') return null;
  const owner = parts[0];
  const repo = parts[1];
  const tag = parts[4];
  const fileSegments = parts.slice(5);
  const fileName = decodeURIComponent(fileSegments[fileSegments.length - 1] || '');
  if (!fileName) return null;
  const canonicalUrl = `https://github.com/${owner}/${repo}/releases/download/${encodeURIComponent(tag)}/${fileSegments.map(encodeURIComponent).join('/')}`;
  return { owner, repo, tag, fileName, canonicalUrl };
}

interface GhAsset {
  name?: string;
  size?: number;
  browser_download_url?: string;
}

interface GhReleaseResponse {
  assets?: GhAsset[];
}

async function fetchAssetSize(p: ParsedGhRelease): Promise<number | undefined> {
  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(p.owner)}/${encodeURIComponent(p.repo)}/releases/tags/${encodeURIComponent(p.tag)}`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...getGithubAuthHeaders(apiUrl, getGithubToken()),
  };
  try {
    const res = await fetch(apiUrl, { headers, redirect: 'follow' });
    if (!res.ok) return undefined;
    const body = await res.json() as GhReleaseResponse;
    const asset = (body.assets || []).find(a => a.name === p.fileName);
    if (!asset || typeof asset.size !== 'number' || asset.size <= 0) return undefined;
    return asset.size;
  } catch (err) {
    logger.warn('resolveGithub size probe failed', {
      url: apiUrl, message: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Resolve a GitHub release asset URL into a `ResolvedModel`. Returns null
 * for any URL outside the release-asset shape so callers can fall through
 * to other resolvers.
 *
 * Note: `source` borrows the existing `ResolvedModel.source` enum — github
 * isn't currently listed there, but we cast to keep the wire shape stable
 * for the import-staging UI which only renders the `downloadUrl` + size.
 */
export async function resolveGithubReleaseUrl(url: string): Promise<ResolvedModel | null> {
  if (typeof url !== 'string' || url.length === 0) return null;
  const parsed = parseGithubReleaseUrl(url);
  if (!parsed) return null;
  const sizeBytes = await fetchAssetSize(parsed);
  const suggestedFolder: SuggestedFolder | undefined = guessFolder('', parsed.fileName);
  // ResolvedModel.source is currently 'huggingface' | 'civitai'; widen via
  // an explicit cast so we don't touch every consumer in batch 1. The
  // walker uses `host` from urlSources for routing instead of `source`.
  const out: ResolvedModel = {
    source: 'github' as unknown as ResolvedModel['source'],
    downloadUrl: parsed.canonicalUrl,
    fileName: parsed.fileName,
  };
  if (typeof sizeBytes === 'number') out.sizeBytes = sizeBytes;
  if (suggestedFolder) out.suggestedFolder = suggestedFolder;
  return out;
}
