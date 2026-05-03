// Unit tests for the web_search chat tool. Stubs `fetch` to return a fixed
// SearXNG envelope; asserts the formatter produces the expected text and
// that the JSON-disabled fallback path surfaces a clear error.
//
// `execute()` now returns a structured envelope `{ text, sources }` on the
// happy path so the chat UI can render an ai-elements `<Sources>` block.
// Failure / empty paths still return a plain string for backward compat.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { webSearchTool, _formatResults } from '../../../../src/services/chat/tools/webSearch.js';

function envelopeText(out: unknown): string {
  if (typeof out === 'string') return out;
  if (out && typeof out === 'object' && typeof (out as { text?: unknown }).text === 'string') {
    return (out as { text: string }).text;
  }
  throw new Error(`unexpected output shape: ${JSON.stringify(out)}`);
}

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
      { execute: (input: { query: string; max?: number }, opts: unknown) => Promise<unknown> };
    const out = await t.execute({ query: 'olares one ai', max: 2 }, {});
    const text = envelopeText(out);
    expect(text).toContain('Olares One');
    expect(text).toContain('Reviews of self-hosted');
    // Side-channel sources mirror the same two results so the UI can render
    // an ai-elements <Sources> block keyed on URL.
    const sources = (out as { sources?: Array<{ title: string; url: string; snippet: string }> }).sources;
    expect(Array.isArray(sources)).toBe(true);
    expect(sources?.length).toBe(2);
    expect(sources?.[0].url).toBe('https://example.com/olares-one');
    expect(sources?.[0].title).toContain('Olares One');
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
      { execute: (input: { query: string }, opts: unknown) => Promise<unknown> };
    const out = await t.execute({ query: 'hello' }, {});
    const text = envelopeText(out);
    expect(text.toLowerCase()).toContain('did not return json');
    expect(text).toContain('settings.yml');
  });

  it('returns a structured failure when SearXNG is unreachable', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const t = webSearchTool({ baseUrl: 'https://searx.example' }) as
      { execute: (input: { query: string }, opts: unknown) => Promise<unknown> };
    const out = await t.execute({ query: 'hello' }, {});
    const text = envelopeText(out);
    expect(text).toMatch(/web_search failed/);
    expect(text).toContain('ECONNREFUSED');
  });

  it('returns "no results" when the envelope is empty', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const t = webSearchTool({ baseUrl: 'https://searx.example' }) as
      { execute: (input: { query: string }, opts: unknown) => Promise<unknown> };
    const out = await t.execute({ query: 'nothing here' }, {});
    const text = envelopeText(out);
    expect(text).toMatch(/^No results/);
  });
});
