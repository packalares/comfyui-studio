// Helpers for the catalog `urlSources[]` field.
//
// Splits host detection + dedup/sort/merge logic out of `catalog.ts` so the
// service file stays under the 250-line cap and so the walker / refresh-size
// path can reuse the same priority ordering without going through upsert.
//
// Priority is fixed by host family (hf=0, civitai=1, github=2, generic=3);
// after sort the entry at index 0 is the best candidate, which the caller
// mirrors onto the legacy `url` field for backwards compatibility.

import type { CatalogModel, UrlHost, UrlSource } from '../contracts/catalog.contract.js';

const HOST_PRIORITY: Record<UrlHost, number> = {
  hf: 0,
  civitai: 1,
  github: 2,
  generic: 3,
};

/** Detect the host family for a URL. Falls back to 'generic' for valid http(s). */
export function detectUrlHost(url: string): UrlHost | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase();
  if (host === 'huggingface.co' || host === 'www.huggingface.co' || host === 'hf-mirror.com') return 'hf';
  if (host === 'civitai.com' || host === 'www.civitai.com') return 'civitai';
  if (host === 'github.com' || host === 'www.github.com'
      || host === 'objects.githubusercontent.com' || host === 'github-releases.githubusercontent.com'
      || host === 'release-assets.githubusercontent.com') {
    return 'github';
  }
  return 'generic';
}

/** Stable sort by host priority, falling back to insertion order. */
export function sortUrlSources(sources: UrlSource[]): UrlSource[] {
  return sources
    .map((s, idx) => ({ s, idx }))
    .sort((a, b) => {
      const pa = HOST_PRIORITY[a.s.host];
      const pb = HOST_PRIORITY[b.s.host];
      if (pa !== pb) return pa - pb;
      return a.idx - b.idx;
    })
    .map(({ s }) => s);
}

/**
 * Merge `incoming` into `existing` by URL, then sort. Same-URL entries are
 * deduped (the existing `declaredBy` wins to preserve attribution of the
 * earliest discovery). Returns a new array; `existing` is not mutated.
 */
export function mergeUrlSources(
  existing: UrlSource[] | undefined,
  incoming: UrlSource[],
): UrlSource[] {
  const seen = new Map<string, UrlSource>();
  for (const cur of existing || []) {
    if (cur.url && !seen.has(cur.url)) seen.set(cur.url, cur);
  }
  for (const inc of incoming) {
    if (!inc.url) continue;
    if (!seen.has(inc.url)) seen.set(inc.url, inc);
  }
  return sortUrlSources(Array.from(seen.values()));
}

/**
 * Build a single `UrlSource` from a raw URL + declaredBy tag. Returns null
 * when the URL is malformed or non-http(s).
 */
export function urlSourceFor(url: string, declaredBy: string): UrlSource | null {
  if (!url || typeof url !== 'string') return null;
  const host = detectUrlHost(url);
  if (!host) return null;
  return { url, host, declaredBy };
}

/** Map a catalog row's `source` tag to the urlSources `declaredBy` value. */
export function declaredByFor(entry: Partial<CatalogModel>): string {
  const s = entry.source;
  if (typeof s !== 'string' || !s) return 'seed';
  return s;
}

/**
 * Merge missing/overwriteable fields from `entry` into `existing`. Mutates
 * `existing` in place. Encodes the urlSources merge + legacy-url mirror +
 * `template:`/`user`/`manual` save_path overwrite + downloading-flag /
 * thumbnail / error / size_bytes precedence rules.
 */
export function mergeIntoExisting(
  existing: CatalogModel,
  entry: Partial<CatalogModel>,
): void {
  // urlSources first so the legacy `url` always reflects the new priority
  // winner. Templates / user resolutions overwrite the legacy `url` when a
  // higher-priority source arrives, because they are authoritative.
  if (entry.url) {
    const src = urlSourceFor(entry.url, declaredByFor(entry));
    if (src) existing.urlSources = mergeUrlSources(existing.urlSources, [src]);
  } else if (!existing.urlSources && existing.url) {
    // Lazy migration when an old row is touched without a fresh url:
    // synthesize a single-entry urlSources from the legacy url.
    const src = urlSourceFor(existing.url, declaredByFor(existing));
    if (src) existing.urlSources = [src];
  }
  if (existing.urlSources && existing.urlSources.length > 0) {
    existing.url = existing.urlSources[0].url;
  } else if (!existing.url && entry.url) {
    existing.url = entry.url;
  }
  if (!existing.name && entry.name) existing.name = entry.name;
  if (!existing.type && entry.type) existing.type = entry.type;
  if (
    entry.save_path
    && (entry.source?.startsWith('template:') || entry.source === 'user' || !existing.save_path)
  ) {
    existing.save_path = entry.save_path;
  }
  if (!existing.description && entry.description) existing.description = entry.description;
  if (!existing.reference && entry.reference) existing.reference = entry.reference;
  if (!existing.base && entry.base) existing.base = entry.base;
  if (entry.thumbnail !== undefined) existing.thumbnail = entry.thumbnail;
  if (entry.downloading !== undefined) existing.downloading = entry.downloading;
  if (entry.error !== undefined) existing.error = entry.error;
  // Gated state propagates (set OR clear). A later non-gated upsert needs to
  // be able to clear stale gated flags after the user pastes a token, so
  // `entry.gated === false` is treated as authoritative; `undefined` leaves
  // the existing value alone.
  if (entry.gated !== undefined) existing.gated = entry.gated;
  if (entry.gated_message !== undefined) existing.gated_message = entry.gated_message;
  if ((!existing.size_bytes || existing.size_bytes === 0) && entry.size_bytes) {
    existing.size_bytes = entry.size_bytes;
    if (entry.size_pretty) existing.size_pretty = entry.size_pretty;
  }
}
