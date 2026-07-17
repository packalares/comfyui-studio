// `searchModels` query-string assembly. The route handler forwards
// types/baseModels/period/sort/nsfw to CivitAI; this test pins the exact
// URL shape so a regression that accidentally drops one of the filters
// fails loudly instead of silently returning unfiltered results.
//
// Encoding note: CivitAI accepts repeated-key array params WITHOUT
// `[]` suffixes (`types=LORA&types=VAE`). A `types[]=LORA` form is
// silently dropped by the upstream server — verified against the live
// API. Assertions below pin the no-bracket form.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { searchModels } from '../../src/services/civitai/models.js';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('searchModels filter forwarding', () => {
  let originalFetch: typeof fetch;
  let capturedUrl = '';

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    capturedUrl = '';
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === 'string' ? input : input.toString();
      return jsonResponse({ items: [], metadata: {} });
    }) as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('emits types, baseModels (repeated keys, no brackets), nsfw, period, sort when supplied', async () => {
    await searchModels('qwen', {
      limit: 12,
      types: ['LORA', 'VAE'],
      baseModels: ['Qwen Image'],
      nsfw: true,
      period: 'Month',
      sort: 'Most Downloaded',
    });
    // Decode so assertions read against literal keys not %5B%5D shapes.
    const decoded = decodeURIComponent(capturedUrl);
    // Repeated-key form, no [] — CivitAI silently ignores the bracketed
    // variant. Assert both that the key/value pair is present AND that no
    // bracketed form leaked in.
    expect(decoded).toContain('types=LORA');
    expect(decoded).toContain('types=VAE');
    expect(decoded).toContain('baseModels=Qwen Image');
    expect(decoded).not.toContain('types[]');
    expect(decoded).not.toContain('baseModels[]');
    expect(decoded).toContain('nsfw=true');
    expect(decoded).toContain('period=Month');
    expect(decoded).toContain('sort=Most Downloaded');
    expect(decoded).toContain('query=qwen');
  });

  it('allows filter-only browse (empty query + at least one filter)', async () => {
    await searchModels('', {
      limit: 24,
      types: ['LORA'],
    });
    const decoded = decodeURIComponent(capturedUrl);
    expect(decoded).toContain('types=LORA');
    expect(decoded).not.toContain('types[]');
    expect(decoded).not.toMatch(/[?&]query=/);
  });

  it('rejects fully-empty calls (no query, no filters)', async () => {
    await expect(searchModels('', {})).rejects.toThrow(/Missing search query/);
  });

  it('threads cursor when provided', async () => {
    await searchModels('sd', { cursor: 'abc123' });
    expect(decodeURIComponent(capturedUrl)).toContain('cursor=abc123');
  });
});
