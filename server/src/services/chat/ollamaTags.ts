// Scrape https://ollama.com/library/<name>/tags — list of all tag variants
// for a given model. Returns the tag identifier (the `<name>:<tag>` part),
// size string, context-window string, input modality, short digest, and
// "<duration> ago" timestamp.
//
// Caching: per-model entries with 1h TTL, plus an in-flight promise per model
// to coalesce concurrent requests. Mirrors the index-scraper pattern in
// `ollamaLibrary.ts`. Scrapes the desktop row (`<div class="grid
// grid-cols-12 items-center">`) since it has stable column positions; the
// mobile row uses bullet-separated text that's harder to parse.

import { logger } from '../../lib/logger.js';

const TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const MIN_TAGS = 1;

export interface OllamaTagEntry {
  /** The full reference: e.g. `8b`, `70b-instruct-q4_K_M`, `latest`. */
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

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<OllamaTagEntry[]>>();

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

export function parseTagsHtml(html: string, modelName: string): OllamaTagEntry[] {
  const out: OllamaTagEntry[] = [];
  // Match the desktop row container; non-greedy to stop at the next sibling.
  // Using `[\s\S]` for cross-line matching since the rows are pretty-printed.
  const rowRe = /<div class="hidden md:flex flex-col space-y-\[6px\]">([\s\S]*?)<div class="flex text-neutral-500 text-xs items-center">([\s\S]*?)<\/div>\s*<\/div>/g;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html)) !== null) {
    const top = m[1];
    const bottom = m[2];

    // Tag href: <a href="/library/<name>:<tag>">
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

    // Bottom row: `<span class="font-mono text-[11px]">DIGEST</span>·<rest>`
    const digestMatch = /<span class="font-mono text-\[11px\]">([\s\S]*?)<\/span>/.exec(bottom);
    const digest = digestMatch ? stripTags(digestMatch[1]) : '';
    // The "X ago" text is the trailing portion after the digest span. Strip
    // remaining tags + leading bullet/whitespace.
    const updatedRaw = stripTags(bottom.replace(/<span class="font-mono text-\[11px\]">[\s\S]*?<\/span>/, ''));
    const updated = updatedRaw.replace(/^[·•\s]+/, '').trim();

    out.push({ tag, size, contextLength, input, digest, updated });
  }
  return out;
}

async function fetchOnce(modelName: string): Promise<OllamaTagEntry[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`https://ollama.com/library/${encodeURIComponent(modelName)}/tags`, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'comfyui-studio/1.0' },
    });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const html = await res.text();
    const parsed = parseTagsHtml(html, modelName);
    if (parsed.length < MIN_TAGS) {
      logger.warn('ollama tags: parse returned no entries', { model: modelName });
      const stale = cache.get(modelName)?.value;
      if (stale && stale.length >= MIN_TAGS) return stale;
      return [];
    }
    cache.set(modelName, { value: parsed, expiresAt: Date.now() + TTL_MS });
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

export async function getOllamaTags(modelName: string): Promise<OllamaTagEntry[]> {
  const now = Date.now();
  const hit = cache.get(modelName);
  if (hit && hit.expiresAt > now) return hit.value;
  const existing = inFlight.get(modelName);
  if (existing) return existing;
  const p = fetchOnce(modelName)
    .catch((err) => {
      logger.warn('ollama tags fetch failed', {
        model: modelName,
        error: err instanceof Error ? err.message : String(err),
      });
      return cache.get(modelName)?.value ?? [];
    })
    .finally(() => { inFlight.delete(modelName); });
  inFlight.set(modelName, p);
  return p;
}

export function _resetCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}
