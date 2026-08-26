// Ollama.com HTML scrapers: library index and per-model tag pages.
// Both scrape ollama.com via regex (no cheerio), use different caching
// strategies (sqlite vs in-memory TTL), and are distinct from the local
// Ollama API helpers in ollama.ts.

import { logger } from '../../lib/logger.js';
import * as repo from '../../lib/db/ollamaLibrary.repo.js';

// ---------- ollamaLibrary ----------

const LIBRARY_URL = 'https://ollama.com/library';
const LIBRARY_MIN_CARDS = 50;
const LIBRARY_FETCH_TIMEOUT_MS = 8000;

export interface OllamaLibraryModel {
  name: string;
  title: string;
  description: string;
  pulls: string;
  tagCount: string;
  updated: string;
  sizes: string[];
  capabilities: string[];
}

let inFlightLibrary: Promise<OllamaLibraryModel[]> | null = null;

/**
 * Convert an Ollama-library "X ago" relative time into approximate seconds-ago
 * (smaller = newer). Used as the sort key so the catalog orders newest-first.
 * Returns a large sentinel for unparseable strings so they sink to the bottom.
 *
 * Recognised forms:
 *   "today" / "just now"             → 0
 *   "yesterday"                       → 86 400
 *   "N seconds/minutes/hours ago"     → N × unit
 *   "N days/weeks/months/years ago"   → N × unit
 *   "N day/week/month/year ago"       → singular tolerated
 */
const SENTINEL_AGO_SEC = 9_999_999_999;
const UNIT_SECONDS: Record<string, number> = {
  second: 1,
  minute: 60,
  hour: 3600,
  day: 86_400,
  week: 7 * 86_400,
  month: 30 * 86_400,
  year: 365 * 86_400,
};

export function parseRelativeAgoSeconds(s: string): number {
  if (!s) return SENTINEL_AGO_SEC;
  const lower = s.toLowerCase().trim();
  if (lower === 'today' || lower === 'just now') return 0;
  if (lower === 'yesterday') return UNIT_SECONDS.day;
  const m = /(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago/.exec(lower);
  if (!m) return SENTINEL_AGO_SEC;
  const n = parseInt(m[1], 10);
  const unit = UNIT_SECONDS[m[2]] ?? 0;
  if (!Number.isFinite(n) || unit === 0) return SENTINEL_AGO_SEC;
  return n * unit;
}

function decodeEntities(s: string): string {
  // Decode `&amp;` LAST so an already-escaped `&amp;lt;` decodes to the literal
  // `&lt;` rather than being double-unescaped into `<`.
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function stripTags(html: string): string {
  // Loop until stable so overlapping/nested constructs (e.g. `<scr<b>ipt>`)
  // can't survive a single pass.
  let prev: string;
  let out = html;
  do { prev = out; out = out.replace(/<[^>]*>/g, ''); } while (out !== prev);
  return decodeEntities(out).replace(/\s+/g, ' ').trim();
}

function attr(html: string, name: string): string {
  const re = new RegExp(`${name}\\s*=\\s*"([^"]*)"`);
  const m = re.exec(html);
  return m ? decodeEntities(m[1]) : '';
}

/** Text of every `<span>` inside `card` whose open tag contains `classToken`
 *  (a regex fragment, so `#`/`[`/`]` in a Tailwind arbitrary value must be
 *  pre-escaped by the caller). Ollama's badges carry no semantic markers —
 *  only their colour classes distinguish a capability chip from a size chip —
 *  so we key off those. */
function collectSpans(card: string, classToken: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<span[^>]*${classToken}[^>]*>([^<]+)</span>`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(card)) !== null) {
    const txt = decodeEntities(m[1]).trim();
    if (txt.length > 0) out.push(txt);
  }
  return out;
}

/**
 * Parse the ollama.com/library index into model rows.
 *
 * HISTORY: this originally keyed off `x-test-*` attributes (`x-test-model`,
 * `x-test-capability`, `x-test-size`, …). Ollama removed every one of those
 * from the library page around mid-2026, so the old parser silently matched
 * zero cards — which tripped `scrapeLibraryOnce`'s `< LIBRARY_MIN_CARDS`
 * guard and made every refresh a no-op, freezing the cached table. There is
 * no test hook in the new markup, so we key off the structural Tailwind
 * classes instead:
 *   - each card is `<a href="/library/<name>" class="group …"> … </a>`
 *   - description is the `max-w-lg` paragraph
 *   - capability chips are `bg-indigo-50` spans; size chips are `bg-[#ddf4ff]`
 *   - pulls / tags / updated live in the `my-4` stats paragraph as
 *     "<n> Pulls", "<n> Tags", "Updated <relative time>"
 * These are load-bearing on Ollama's CSS, so a future redesign can break this
 * again — the `LIBRARY_MIN_CARDS` guard is what turns that into "stale cache"
 * rather than "wiped cache".
 */
export function parseLibraryHtml(html: string): OllamaLibraryModel[] {
  const out: OllamaLibraryModel[] = [];
  const cardRe = /<a[^>]*href="\/library\/([^"#?]+)"[^>]*class="group[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = cardRe.exec(html)) !== null) {
    const name = decodeEntities(m[1]);
    const card = m[2];
    if (!name) continue;
    const title = attr(card, 'title') || name;
    const descMatch = /<p[^>]*class="[^"]*max-w-lg[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(card);
    const description = descMatch ? stripTags(descMatch[1]) : '';
    const capabilities = collectSpans(card, 'bg-indigo-50');
    const sizes = collectSpans(card, 'bg-\\[#ddf4ff\\]');
    const statMatch = /<p[^>]*class="[^"]*my-4[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(card);
    const stats = statMatch ? stripTags(statMatch[1]) : '';
    const pulls = (/([\d.]+[KMB]?)\s+Pulls/i.exec(stats) ?? [])[1] ?? '';
    const tagCount = (/(\d+)\s+Tags?/i.exec(stats) ?? [])[1] ?? '';
    const updated = (/Updated\s+(.+)$/i.exec(stats) ?? [])[1] ?? '';
    out.push({ name, title, description, pulls, tagCount, updated, sizes, capabilities });
  }
  return out;
}

/**
 * Run one upstream scrape. On parse-failure (too few cards) returns null —
 * caller decides whether to fall back to existing DB rows.
 */
async function scrapeLibraryOnce(): Promise<OllamaLibraryModel[] | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LIBRARY_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(LIBRARY_URL, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'comfyui-studio/1.0' },
    });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const html = await res.text();
    const parsed = parseLibraryHtml(html);
    if (parsed.length < LIBRARY_MIN_CARDS) {
      logger.warn('ollama library: parse returned suspiciously few cards', {
        count: parsed.length, min: LIBRARY_MIN_CARDS,
      });
      return null;
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Scrape upstream and replace the entire `ollama_library` table in a single
 * transaction. Concurrent callers share a single in-flight scrape so a
 * cold-start race doesn't fan out N hits to ollama.com. On parse failure,
 * existing DB rows are left untouched.
 */
export async function refreshOllamaLibrary(): Promise<{ replaced: boolean; total: number }> {
  if (inFlightLibrary) {
    await inFlightLibrary.catch(() => {});
    return { replaced: false, total: repo.count() };
  }
  const promise = scrapeLibraryOnce()
    .catch((err) => {
      logger.warn('ollama library fetch failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    });
  inFlightLibrary = promise.then((rows) => rows ?? []);
  try {
    const rows = await promise;
    if (!rows) return { replaced: false, total: repo.count() };
    const fetchedAt = Date.now();
    repo.replaceAll(rows.map((r) => ({
      name: r.name,
      title: r.title,
      description: r.description,
      pulls: r.pulls,
      tag_count: r.tagCount,
      updated: r.updated,
      sizes: r.sizes,
      capabilities: r.capabilities,
      fetched_at: fetchedAt,
      updated_ago_sec: parseRelativeAgoSeconds(r.updated),
    })));
    return { replaced: true, total: rows.length };
  } finally {
    inFlightLibrary = null;
  }
}

export interface ListLibraryOpts {
  q?: string;
  page?: number;
  pageSize?: number;
}

export interface ListLibraryResult {
  items: OllamaLibraryModel[];
  total: number;
  page: number;
  pageSize: number;
  fetchedAt: number;
}

/**
 * Serve the cached catalog if it's still fresh, otherwise re-scrape in the
 * background (stale-while-revalidate) — the next read gets the new rows.
 * Without this the table only ever refreshed on an empty DB or the manual
 * Refresh button, so a cache seeded once would silently miss every model
 * Ollama published afterward (this is exactly how the table sat frozen for
 * ~2.5 months). 24h keeps upstream load negligible while never being more
 * than a day behind. Note it is deliberately NOT the fetch age but the age
 * of the freshest row we have — `lastFetchedAt` is stamped by `replaceAll`.
 */
const LIBRARY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Paginated read from the `ollama_library` table. If the table is empty
 * (fresh install / freshly migrated DB) we run one seed scrape so the
 * caller doesn't get an empty list on first use; if it's merely stale we
 * revalidate in the background and serve what we have now.
 */
export async function getOllamaLibrary(opts: ListLibraryOpts = {}): Promise<ListLibraryResult> {
  if (repo.count() === 0) {
    await refreshOllamaLibrary();
  } else if (Date.now() - repo.lastFetchedAt() > LIBRARY_TTL_MS) {
    // Fire-and-forget: don't make this reader wait on the network. The
    // in-flight guard in refreshOllamaLibrary dedupes concurrent triggers.
    void refreshOllamaLibrary().catch(() => {});
  }
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.max(1, Math.min(200, opts.pageSize ?? 50));
  const offset = (page - 1) * pageSize;
  const { items, total } = repo.list({ q: opts.q, limit: pageSize, offset });
  return {
    items: items.map((r) => ({
      name: r.name,
      title: r.title,
      description: r.description,
      pulls: r.pulls,
      tagCount: r.tag_count,
      updated: r.updated,
      sizes: r.sizes,
      capabilities: r.capabilities,
    })),
    total,
    page,
    pageSize,
    fetchedAt: repo.lastFetchedAt(),
  };
}

export function _resetLibraryCacheForTests(): void {
  inFlightLibrary = null;
}

// ---------- ollamaTags ----------

const TAGS_TTL_MS = 60 * 60 * 1000;
const TAGS_FETCH_TIMEOUT_MS = 8000;
const TAGS_MIN_ENTRIES = 1;

export interface OllamaTagEntry {
  /** Full reference: e.g. `8b`, `70b-instruct-q4_K_M`, `latest`. */
  tag: string;
  /** Size string as shown on ollama.com, e.g. "2.0GB". */
  size: string;
  /** Context window string, e.g. "128K". */
  contextLength: string;
  /** Input modality string, e.g. "Text", "Image, Text". */
  input: string;
  /** Short content hash (12-char hex prefix). */
  digest: string;
  /** Updated string, e.g. "1 year ago". */
  updated: string;
}

interface CacheEntry {
  value: OllamaTagEntry[];
  expiresAt: number;
}

const tagsCache = new Map<string, CacheEntry>();
const tagsInFlight = new Map<string, Promise<OllamaTagEntry[]>>();

export function parseTagsHtml(html: string, modelName: string): OllamaTagEntry[] {
  const out: OllamaTagEntry[] = [];
  const rowRe = /<div class="hidden md:flex flex-col space-y-\[6px\]">([\s\S]*?)<div class="flex text-neutral-500 text-xs items-center">([\s\S]*?)<\/div>\s*<\/div>/g;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html)) !== null) {
    const top = m[1];
    const bottom = m[2];

    const escName = modelName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hrefMatch = new RegExp(`href="/library/${escName}:([^"]+)"`).exec(top);
    if (!hrefMatch) continue;
    const tag = decodeEntities(hrefMatch[1]);

    // Three `col-span-2` cells in fixed order: size, context, input.
    const colRe = /<(?:p|div) class="col-span-2[^"]*">([\s\S]*?)<\/(?:p|div)>/g;
    const cols: string[] = [];
    let cm: RegExpExecArray | null;
    while ((cm = colRe.exec(top)) !== null) {
      cols.push(stripTags(cm[1]));
      if (cols.length === 3) break;
    }
    const size = cols[0] ?? '';
    const contextLength = cols[1] ?? '';
    const input = cols[2] ?? '';

    const digestMatch = /<span class="font-mono text-\[11px\]">([\s\S]*?)<\/span>/.exec(bottom);
    const digest = digestMatch ? stripTags(digestMatch[1]) : '';
    const updatedRaw = stripTags(bottom.replace(/<span class="font-mono text-\[11px\]">[\s\S]*?<\/span>/, ''));
    const updated = updatedRaw.replace(/^[·•\s]+/, '').trim();

    out.push({ tag, size, contextLength, input, digest, updated });
  }
  return out;
}

async function fetchTagsOnce(modelName: string): Promise<OllamaTagEntry[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TAGS_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`https://ollama.com/library/${encodeURIComponent(modelName)}/tags`, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'comfyui-studio/1.0' },
    });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const html = await res.text();
    const parsed = parseTagsHtml(html, modelName);
    if (parsed.length < TAGS_MIN_ENTRIES) {
      logger.warn('ollama tags: parse returned no entries', { model: modelName });
      const stale = tagsCache.get(modelName)?.value;
      if (stale && stale.length >= TAGS_MIN_ENTRIES) return stale;
      return [];
    }
    tagsCache.set(modelName, { value: parsed, expiresAt: Date.now() + TAGS_TTL_MS });
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

export async function getOllamaTags(modelName: string): Promise<OllamaTagEntry[]> {
  const now = Date.now();
  const hit = tagsCache.get(modelName);
  if (hit && hit.expiresAt > now) return hit.value;
  const existing = tagsInFlight.get(modelName);
  if (existing) return existing;
  const p = fetchTagsOnce(modelName)
    .catch((err) => {
      logger.warn('ollama tags fetch failed', {
        model: modelName,
        error: err instanceof Error ? err.message : String(err),
      });
      return tagsCache.get(modelName)?.value ?? [];
    })
    .finally(() => { tagsInFlight.delete(modelName); });
  tagsInFlight.set(modelName, p);
  return p;
}

export function _resetTagsCacheForTests(): void {
  tagsCache.clear();
  tagsInFlight.clear();
}

// Keep old test helper name working (ollamaLibrary.ts exported _resetCacheForTests).
export { _resetLibraryCacheForTests as _resetCacheForTests };
