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

/** Outcome of a release-tags GET. `status: 0` flags network/timeout/transient
 * errors; the caller keeps the URL but skips size + gated branches. */
interface AssetOutcome { status: number; sizeBytes?: number }

async function fetchAssetSize(p: ParsedGhRelease): Promise<AssetOutcome> {
  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(p.owner)}/${encodeURIComponent(p.repo)}/releases/tags/${encodeURIComponent(p.tag)}`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...getGithubAuthHeaders(apiUrl, getGithubToken()),
  };
  try {
    const res = await fetch(apiUrl, { headers, redirect: 'follow' });
    if (res.status !== 200) return { status: res.status };
    const body = await res.json() as GhReleaseResponse;
    const asset = (body.assets || []).find(a => a.name === p.fileName);
    if (!asset || typeof asset.size !== 'number' || asset.size <= 0) return { status: 200 };
    return { status: 200, sizeBytes: asset.size };
  } catch (err) {
    logger.warn('resolveGithub size probe failed', {
      url: apiUrl, message: err instanceof Error ? err.message : String(err),
    });
    return { status: 0 };
  }
}

/**
 * Resolve a GitHub release asset URL into a `ResolvedModel`. Returns null
 * for any URL outside the release-asset shape so callers can fall through
 * to other resolvers.
 *
 * API status mapping:
 *   - 200      → populate sizeBytes when present, return resolved.
 *   - 401/403  → return resolved with `gated: true` + Settings-token prompt.
 *   - 404/410 / 5xx / network — return resolved with no size and no gated
 *     flag. Unlike HF/CivitAI we never null on 404 here: the API endpoint
 *     we probe (`releases/tags/<tag>`) is a SIZE-only side-channel — the
 *     download URL itself is parsed locally from the user's input and
 *     remains valid even if the tags API can't see the release.
 *
 * Note: `source` borrows the existing `ResolvedModel.source` enum — github
 * isn't currently listed there, but we cast to keep the wire shape stable
 * for the import-staging UI which only renders the `downloadUrl` + size.
 */
export async function resolveGithubReleaseUrl(url: string): Promise<ResolvedModel | null> {
  if (typeof url !== 'string' || url.length === 0) return null;
  const parsed = parseGithubReleaseUrl(url);
  if (!parsed) return null;
  const probe = await fetchAssetSize(parsed);
  const suggestedFolder: SuggestedFolder | undefined = guessFolder('', parsed.fileName);
  const out: ResolvedModel = {
    source: 'github' as unknown as ResolvedModel['source'],
    downloadUrl: parsed.canonicalUrl,
    fileName: parsed.fileName,
  };
  if (probe.status === 401 || probe.status === 403) {
    out.gated = true;
    out.gatedMessage = 'paste your GitHub token in Settings to download';
  }
  if (typeof probe.sizeBytes === 'number') out.sizeBytes = probe.sizeBytes;
  if (suggestedFolder) out.suggestedFolder = suggestedFolder;
  return out;
}
