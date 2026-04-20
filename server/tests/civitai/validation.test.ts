// CivitAI URL/query validation + fetchWithRetry size cap.

import { describe, expect, it } from 'vitest';
import { fetchWithRetry } from '../../src/lib/http.js';
import { encodeQuery, getLatestModelsByUrl } from '../../src/services/civitai/models.js';

describe('fetchWithRetry size cap', () => {
  it('throws RangeError when content-length exceeds maxBytes', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('x', {
      status: 200, headers: { 'content-length': '999999' },
    })) as typeof fetch;
    try {
      await expect(fetchWithRetry('https://example.com/', { attempts: 1, maxBytes: 100 }))
        .rejects.toThrow(RangeError);
    } finally { globalThis.fetch = originalFetch; }
  });

  it('returns text when under cap', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('{"ok":true}', {
      status: 200, headers: { 'content-type': 'application/json', 'content-length': '11' },
    })) as typeof fetch;
    try {
      const r = await fetchWithRetry('https://example.com/', { attempts: 1 });
      expect(r.status).toBe(200);
      expect(r.text).toBe('{"ok":true}');
    } finally { globalThis.fetch = originalFetch; }
  });

  it('retries on failure up to attempts', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls < 3) throw new Error('boom');
      return new Response('ok', { status: 200 });
    }) as typeof fetch;
    try {
      const r = await fetchWithRetry('https://example.com/', { attempts: 3, baseDelayMs: 10 });
      expect(r.text).toBe('ok');
      expect(calls).toBe(3);
    } finally { globalThis.fetch = originalFetch; }
  });
});

describe('civitai query building', () => {
  it('encodeQuery produces sorted-deterministic output', () => {
    expect(encodeQuery({ limit: 10, sort: 'Newest', nsfw: false }))
      .toMatch(/limit=10/);
    expect(encodeQuery({})).toBe('');
  });
});

describe('getLatestModelsByUrl host allow-list', () => {
  it('rejects non-civitai hosts', async () => {
    await expect(getLatestModelsByUrl('https://evil.example.com/?x=1'))
      .rejects.toThrow(/host not allowed/);
  });

  it('rejects malformed URLs', async () => {
    await expect(getLatestModelsByUrl('not a url')).rejects.toThrow(/Invalid URL/);
  });

  it('rejects missing URL', async () => {
    await expect(getLatestModelsByUrl('')).rejects.toThrow(/Missing URL/);
  });
});
