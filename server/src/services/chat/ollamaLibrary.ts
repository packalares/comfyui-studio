// Scrape https://ollama.com/library — list of public models.
//
// Persistence: rows live in the `ollama_library` sqlite table (see
// `lib/db/ollamaLibrary.repo.ts`). The previous module-level 1h cache is
// gone — the DB is the cache. Service contract:
//   - `getOllamaLibrary({ q, page, pageSize })` queries the DB. If the
//     table is empty (cold start, fresh install) it scrapes once to seed.
//   - `refreshOllamaLibrary()` always scrapes + replaces the table — this
//     is the path the UI's Refresh button takes.
//   - Concurrent calls into either function share a single `inFlight`
//     promise so a cold-start avalanche never fans out N upstream hits.
//
// Parsing: the page renders `<li x-test-model>` cards with stable Alpine
// `x-test-*` data attributes. Regexes are sufficient — bringing in a full
// HTML parser for ~9 fields per card is overkill. Threshold: if a scrape
// returns fewer than `MIN_CARDS` cards we treat it as a parse-failure
// regression and DO NOT replace the existing DB rows (otherwise an
// upstream HTML change would silently wipe the catalog).

import { logger } from '../../lib/logger.js';
import * as repo from '../../lib/db/ollamaLibrary.repo.js';

const LIBRARY_URL = 'https://ollama.com/library';
const MIN_CARDS = 50;
const FETCH_TIMEOUT_MS = 8000;

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

let inFlight: Promise<OllamaLibraryModel[]> | null = null;

/**
 * Convert an Ollama-library "X ago" relative time into approximate
 * seconds-ago (smaller = newer). Used as the sort key so the catalog
 * orders newest-first without depending on upstream URL params. Returns
 * a large sentinel for unparseable strings so they sink to the bottom.
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
  month: 30 * 86_400,   // calendar month is fuzzy; 30d is the common convention
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
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

function attr(html: string, name: string): string {
  const re = new RegExp(`${name}\\s*=\\s*"([^"]*)"`);
  const m = re.exec(html);
  return m ? decodeEntities(m[1]) : '';
}

function collect(html: string, attrName: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`${attrName}[^>]*>\\s*([^<]+)<`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const txt = decodeEntities(m[1]).trim();
    if (txt.length > 0) out.push(txt);
  }
  return out;
}

export function parseLibraryHtml(html: string): OllamaLibraryModel[] {
  const out: OllamaLibraryModel[] = [];
  const cardRe = /<li[^>]*\bx-test-model\b[^>]*>([\s\S]*?)<\/li>/g;
  let m: RegExpExecArray | null;
  while ((m = cardRe.exec(html)) !== null) {
    const card = m[1];
    const hrefMatch = /<a[^>]*href="\/library\/([^"#?]+)"/.exec(card);
    const name = hrefMatch ? decodeEntities(hrefMatch[1]) : '';
    if (!name) continue;
    const titleAttr = attr(card, 'x-test-model-title') || attr(card, 'title');
    const titleTagMatch = /<[^>]*x-test-model-title[^>]*>([\s\S]*?)<\/[^>]*>/.exec(card);
    const title = titleAttr || (titleTagMatch ? stripTags(titleTagMatch[1]) : name);
    const descMatch = /<p[^>]*class="[^"]*max-w-lg[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(card);
    const description = descMatch ? stripTags(descMatch[1]) : '';
    const pullsMatch = /<[^>]*x-test-pull-count[^>]*>([\s\S]*?)<\/[^>]*>/.exec(card);
    const pulls = pullsMatch ? stripTags(pullsMatch[1]) : '';
    const tagMatch = /<[^>]*x-test-tag-count[^>]*>([\s\S]*?)<\/[^>]*>/.exec(card);
    const tagCount = tagMatch ? stripTags(tagMatch[1]) : '';
    const updMatch = /<[^>]*x-test-updated[^>]*>([\s\S]*?)<\/[^>]*>/.exec(card);
    const updated = updMatch ? stripTags(updMatch[1]) : '';
    const sizes = collect(card, 'x-test-size');
    const capabilities = collect(card, 'x-test-capability');
    out.push({ name, title, description, pulls, tagCount, updated, sizes, capabilities });
  }
  return out;
}

/**
 * Run one upstream scrape. On parse-failure (too few cards) returns null —
 * caller decides whether to fall back to existing DB rows.
 */
async function scrapeOnce(): Promise<OllamaLibraryModel[] | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(LIBRARY_URL, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'comfyui-studio/1.0' },
    });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const html = await res.text();
    const parsed = parseLibraryHtml(html);
    if (parsed.length < MIN_CARDS) {
      logger.warn('ollama library: parse returned suspiciously few cards', {
        count: parsed.length, min: MIN_CARDS,
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
 * the existing DB rows are left untouched.
 */
export async function refreshOllamaLibrary(): Promise<{ replaced: boolean; total: number }> {
  if (inFlight) {
    await inFlight.catch(() => {});
    return { replaced: false, total: repo.count() };
  }
  const promise = scrapeOnce()
    .catch((err) => {
      logger.warn('ollama library fetch failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    });
  inFlight = promise.then((rows) => rows ?? []);
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
    inFlight = null;
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
 * Paginated read from the `ollama_library` table. If the table is empty
 * (fresh install / freshly migrated DB) we run one seed scrape so the
 * caller doesn't get an empty list on first use. After that, the table
 * only changes via `refreshOllamaLibrary()`.
 */
export async function getOllamaLibrary(opts: ListLibraryOpts = {}): Promise<ListLibraryResult> {
  if (repo.count() === 0) {
    await refreshOllamaLibrary();
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

export function _resetCacheForTests(): void {
  inFlight = null;
}
