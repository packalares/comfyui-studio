// Scrape https://ollama.com/library — list of public models.
//
// Caching: a single module-level entry with 1h TTL. The first request fills
// the cache; concurrent requests during a fetch share a single in-flight
// promise so we don't fan out N upstream hits on a cold start.
//
// Parsing: the page renders `<li x-test-model>` cards with stable Alpine
// `x-test-*` data attributes. We extract them with regexes — bringing in a
// full HTML parser for ~9 fields per card is overkill, and the Alpine
// attribute scheme is mirrored in Ollama's own end-to-end tests so it's
// reasonably stable. If extraction returns fewer than 50 cards we treat it
// as a parse-failure regression and fall back to the cached value (or [])
// rather than serving a half-empty list.

import { logger } from '../../lib/logger.js';

const LIBRARY_URL = 'https://ollama.com/library';
const TTL_MS = 60 * 60 * 1000;
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

interface CacheEntry {
  value: OllamaLibraryModel[];
  expiresAt: number;
}

let cache: CacheEntry | null = null;
let inFlight: Promise<OllamaLibraryModel[]> | null = null;

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

async function fetchOnce(): Promise<OllamaLibraryModel[]> {
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
      const stale = cache?.value;
      if (stale && stale.length >= MIN_CARDS) return stale;
      return [];
    }
    cache = { value: parsed, expiresAt: Date.now() + TTL_MS };
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

export async function getOllamaLibrary(): Promise<OllamaLibraryModel[]> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.value;
  if (inFlight) return inFlight;
  inFlight = fetchOnce()
    .catch((err) => {
      logger.warn('ollama library fetch failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return cache?.value ?? [];
    })
    .finally(() => { inFlight = null; });
  return inFlight;
}

export function _resetCacheForTests(): void {
  cache = null;
  inFlight = null;
}
