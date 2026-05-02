// Unit tests for the web_search chat tool. Stubs `fetch` to return a fixed
// SearXNG envelope; asserts the formatter produces the expected text and
// that the JSON-disabled fallback path surfaces a clear error.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { webSearchTool, _formatResults } from '../../../../src/services/chat/tools/webSearch.js';

const SAMPLE = {
  query: 'olares one ai',
  results: [
    {
      title: 'Olares One — Personal AI server',
      url: 'https://example.com/olares-one',
      content: 'Edge AI box bundled with a self-hosted stack.',
      engine: 'duckduckgo',
    },
    {
      title: 'Reviews of self-hosted LLM appliances',
      url: 'https://example.com/reviews',
      content: 'Comparison of NUC + GPU builds vs prebuilt boxes.',
      engine: 'startpage',
    },
  ],
};

describe('webSearchTool', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.stubGlobal('fetch', realFetch);
    vi.restoreAllMocks();
  });

  it('formats top N results into a numbered list', () => {
    const text = _formatResults(SAMPLE.results, 5);
    expect(text).toContain('1. Olares One');
    expect(text).toContain('https://example.com/olares-one');
    expect(text).toContain('2. Reviews of self-hosted');
    // Trailing whitespace must be trimmed so the model doesn't see
    // dangling blank lines that look like end-of-turn markers.
    expect(text.endsWith('\n')).toBe(false);
  });

  it('caps the result count at the requested max', () => {
    const text = _formatResults(SAMPLE.results, 1);
    expect(text).toContain('1.');
    expect(text).not.toContain('2.');
  });

  it('handles JSON envelope happy path through execute', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(SAMPLE), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const t = webSearchTool({ baseUrl: 'https://searx.example' }) as
      { execute: (input: { query: string; max?: number }, opts: unknown) => Promise<string> };
    const out = await t.execute({ query: 'olares one ai', max: 2 }, {});
    expect(out).toContain('Olares One');
    expect(out).toContain('Reviews of self-hosted');
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('format=json');
    expect(url).toContain('q=olares%20one%20ai');
  });

  it('surfaces a clear error when the instance returns HTML', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(new Response('<html>...</html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    }));
    const t = webSearchTool({ baseUrl: 'https://searx.example' }) as
      { execute: (input: { query: string }, opts: unknown) => Promise<string> };
    const out = await t.execute({ query: 'hello' }, {});
    expect(out.toLowerCase()).toContain('did not return json');
    expect(out).toContain('settings.yml');
  });

  it('returns a structured failure when SearXNG is unreachable', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const t = webSearchTool({ baseUrl: 'https://searx.example' }) as
      { execute: (input: { query: string }, opts: unknown) => Promise<string> };
    const out = await t.execute({ query: 'hello' }, {});
    expect(out).toMatch(/web_search failed/);
    expect(out).toContain('ECONNREFUSED');
  });

  it('returns "no results" when the envelope is empty', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const t = webSearchTool({ baseUrl: 'https://searx.example' }) as
      { execute: (input: { query: string }, opts: unknown) => Promise<string> };
    const out = await t.execute({ query: 'nothing here' }, {});
    expect(out).toMatch(/^No results/);
  });
});
