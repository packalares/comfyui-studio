// `web_search` chat tool — proxies to a SearXNG instance with JSON output
// enabled (`formats: [html, json]` in the instance's settings.yml).
//
// SearXNG returns a JSON envelope `{ query, results: [...], answers, ... }`
// when `format=json` is supported. Servers that haven't enabled JSON respond
// with HTML — we detect that via Content-Type and surface a helpful error so
// the operator knows to flip the flag instead of silently returning nothing.

import { tool } from 'ai';
import { z } from 'zod';

export interface WebSearchConfig {
  baseUrl: string;
}

interface SearxngResult {
  title?: string;
  url?: string;
  content?: string;
  engine?: string;
}

interface SearxngEnvelope {
  results?: SearxngResult[];
  answers?: unknown;
}

const inputSchema = z.object({
  query: z.string().min(1).describe('Free-text search query.'),
  max: z.number().int().positive().max(20).optional()
    .describe('Maximum number of results to return (default 5, hard cap 20).'),
});

async function runSearch(
  baseUrl: string,
  query: string,
  max: number,
): Promise<string> {
  const url = `${baseUrl}/search?format=json&q=${encodeURIComponent(query)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    return `web_search failed: SearXNG returned ${res.status} ${res.statusText}.`;
  }
  // Detect the "JSON output disabled" case: SearXNG falls back to rendering
  // the HTML search page instead of an envelope. The Content-Type is the
  // cleanest signal; the body parses to text-shaped HTML otherwise.
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.toLowerCase().includes('json')) {
    return 'web_search failed: SearXNG instance did not return JSON. '
      + 'Add `formats: [html, json]` to the instance\'s settings.yml '
      + 'and restart it, then try again.';
  }
  const body = await res.json() as SearxngEnvelope;
  const results = Array.isArray(body.results) ? body.results : [];
  if (results.length === 0) {
    return `No results for "${query}".`;
  }
  const top = results.slice(0, max);
  const lines: string[] = [];
  top.forEach((r, i) => {
    const title = (r.title ?? '').trim() || '(untitled)';
    const link = (r.url ?? '').trim();
    const snippet = (r.content ?? '').trim();
    lines.push(`${i + 1}. ${title}`);
    if (link) lines.push(`   ${link}`);
    if (snippet) lines.push(`   ${snippet}`);
    lines.push('');
  });
  return lines.join('\n').trimEnd();
}

export function webSearchTool(config: WebSearchConfig) {
  return tool({
    description: 'Search the public web via a SearXNG metasearch engine. '
      + 'Returns a numbered list of titles, URLs, and snippets — use the URLs '
      + 'as citations when answering the user.',
    inputSchema,
    execute: async ({ query, max }) => {
      const cap = typeof max === 'number' ? Math.max(1, Math.min(20, max)) : 5;
      try {
        return await runSearch(config.baseUrl, query, cap);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `web_search failed: ${msg}`;
      }
    },
  });
}

// Exposed for the test suite — lets fixtures drive the parser without needing
// to stub `fetch` for every shape we want to assert.
export function _formatResults(results: SearxngResult[], max: number): string {
  const top = results.slice(0, max);
  if (top.length === 0) return 'No results.';
  const lines: string[] = [];
  top.forEach((r, i) => {
    lines.push(`${i + 1}. ${(r.title ?? '').trim() || '(untitled)'}`);
    if (r.url) lines.push(`   ${r.url.trim()}`);
    if (r.content) lines.push(`   ${r.content.trim()}`);
    lines.push('');
  });
  return lines.join('\n').trimEnd();
}
