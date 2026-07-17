// Hash verification for model URL sources.
//
// Per entry logic:
//   host==='civitai': pull SHA256 from civitaiRaw.files[].hashes.SHA256 (no extra API call)
//   host==='hf': ONE call to HF tree API to read LFS oid (SHA256) — segments encoded
//                individually; NO encodeURIComponent(owner/repo) to avoid %2F.
//   other: status='unknown'
//
// Compare retrieved hash to localSha256:
//   match → 'ok'  |  different → 'mismatch'  |  not retrieved → 'unknown'/'error'

import { getHfToken } from '../../settings/index.js';
import { logger } from '../../../lib/logger.js';
import type { UrlSource } from '../../../contracts/catalog.contract.js';
import type { UrlSourceVerdict } from './types.js';

export type { UrlSourceVerdict };

// ---- CivitAI hash extraction ----

interface CivitaiFile {
  hashes?: Record<string, string>;
}

interface CivitaiRaw {
  files?: CivitaiFile[];
}

function sha256FromCivitaiRaw(civitaiRaw: unknown): string | undefined {
  if (!civitaiRaw || typeof civitaiRaw !== 'object') return undefined;
  const raw = civitaiRaw as CivitaiRaw;
  if (!Array.isArray(raw.files)) return undefined;
  for (const file of raw.files) {
    const h = file?.hashes;
    if (!h) continue;
    // CivitAI uses 'SHA256' (uppercase)
    const sha = h['SHA256'] ?? h['sha256'];
    if (typeof sha === 'string' && sha.length > 0) return sha.toLowerCase();
  }
  return undefined;
}

// ---- HuggingFace hash extraction via tree API ----

interface HfTreeItem {
  type?: string;
  path?: string;
  lfs?: { oid?: string };
}

/**
 * Fetch HF tree for a specific directory in a repo and find the LFS oid
 * for a given filename.
 *
 * URL pattern: https://huggingface.co/api/models/{owner}/{repo}/tree/main/{subdir}
 * Segments encoded individually — NOT encodeURIComponent(owner/repo) which
 * would turn the slash into %2F and return a 400.
 */
async function sha256FromHfUrl(url: string): Promise<string | undefined> {
  // Parse: https://huggingface.co/{owner}/{repo}/resolve/{ref}/{path}
  let parsed: URL;
  try { parsed = new URL(url); } catch { return undefined; }
  if (parsed.hostname !== 'huggingface.co' && parsed.hostname !== 'hf-mirror.com') return undefined;

  // pathname: /{owner}/{repo}/resolve/{ref}/{...path}
  const parts = parsed.pathname.split('/').filter(Boolean);
  // parts[0]=owner, parts[1]=repo, parts[2]='resolve', parts[3]=ref, parts[4..]=file_path
  if (parts.length < 5 || parts[2] !== 'resolve') return undefined;

  const owner = parts[0];
  const repo = parts[1];
  const ref = parts[3];
  const filePath = parts.slice(4).join('/');
  const basename = filePath.split('/').pop() ?? filePath;
  const subdir = filePath.includes('/') ? filePath.split('/').slice(0, -1).join('/') : '';

  // Build tree URL — encode each segment individually to avoid %2F in the path
  const ownerEnc = encodeURIComponent(owner);
  const repoEnc = encodeURIComponent(repo);
  const refEnc = encodeURIComponent(ref);
  const subdirPath = subdir
    ? '/' + subdir.split('/').map(encodeURIComponent).join('/')
    : '';
  const treeUrl = `https://huggingface.co/api/models/${ownerEnc}/${repoEnc}/tree/${refEnc}${subdirPath}`;

  const token = getHfToken();
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  let items: HfTreeItem[];
  try {
    const res = await fetch(treeUrl, { headers, signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return undefined;
    items = await res.json() as HfTreeItem[];
  } catch (err) {
    clearTimeout(t);
    logger.info('verifyUrls: HF tree fetch failed', {
      url: treeUrl,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }

  if (!Array.isArray(items)) return undefined;
  const file = items.find(
    (i) => i.type === 'file' && i.path?.split('/').pop() === basename,
  );
  const oid = file?.lfs?.oid;
  return typeof oid === 'string' && oid.length > 0 ? oid.toLowerCase() : undefined;
}

// ---- Main export ----

/**
 * Verify each urlSource entry against the known local SHA256.
 * Returns one verdict per entry; never throws.
 */
export async function verifyUrlSources(
  urlSources: UrlSource[],
  localSha256: string | undefined,
  civitaiRaw: unknown,
): Promise<UrlSourceVerdict[]> {
  const verdicts: UrlSourceVerdict[] = [];

  for (const src of urlSources) {
    let upstreamSha: string | undefined;
    let error: string | undefined;

    try {
      if (src.host === 'civitai') {
        upstreamSha = sha256FromCivitaiRaw(civitaiRaw);
      } else if (src.host === 'hf') {
        upstreamSha = await sha256FromHfUrl(src.url);
      }
      // other hosts: upstreamSha stays undefined → status 'unknown'
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    let status: UrlSourceVerdict['status'];
    if (error) {
      status = 'error';
    } else if (upstreamSha === undefined) {
      status = 'unknown';
    } else if (!localSha256) {
      status = 'unknown';
    } else if (upstreamSha === localSha256.toLowerCase()) {
      status = 'ok';
    } else {
      status = 'mismatch';
    }

    const verdict: UrlSourceVerdict = {
      url: src.url,
      host: src.host,
      declaredBy: src.declaredBy,
      status,
    };
    if (upstreamSha !== undefined) verdict.sha256 = upstreamSha;
    if (error) verdict.error = error;

    verdicts.push(verdict);
  }

  return verdicts;
}
