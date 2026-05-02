// Unit tests for the rag_search chat tool. Stubs `fetch` against the
// expected RAGFlow `/api/v1/retrieval` shape (verified against the public
// HTTP API reference).

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ragSearchTool, formatChunks } from '../../../../src/services/chat/tools/ragSearch.js';

const FIXTURE = {
  code: 0,
  data: {
    chunks: [
      {
        content: 'Olares One ships with a self-hosted Ollama backend.',
        document_keyword: 'olares-one-spec.pdf',
        similarity: 0.91,
      },
      {
        content_with_weight: 'WireGuard is bundled alongside Tailscale.',
        document_name: 'networking.md',
        similarity: 0.83,
      },
    ],
    total: 2,
  },
};

describe('ragSearchTool', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.stubGlobal('fetch', realFetch);
    vi.restoreAllMocks();
  });

  it('formats chunks with similarity + document name', () => {
    const text = formatChunks(FIXTURE.data.chunks, 5);
    expect(text).toContain('1. olares-one-spec.pdf');
    expect(text).toContain('similarity 0.91');
    expect(text).toContain('Olares One ships');
    expect(text).toContain('2. networking.md');
    // content_with_weight wins over `content` when both are present.
    expect(text).toContain('WireGuard is bundled alongside Tailscale.');
  });

  it('caps the chunk count at top_k', () => {
    const text = formatChunks(FIXTURE.data.chunks, 1);
    expect(text).toContain('1. olares-one-spec.pdf');
    expect(text).not.toContain('2. networking.md');
  });

  it('passes question + dataset id + top_k in the request body', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(FIXTURE), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const t = ragSearchTool({
      baseUrl: 'https://ragflow.example',
      apiKey: 'test-key',
    }) as { execute: (input: { query: string; knowledge_base_id?: string; top_k?: number }, opts: unknown) => Promise<string> };
    const out = await t.execute({
      query: 'how does olares one ship?',
      knowledge_base_id: 'ds_001',
      top_k: 3,
    }, {});
    expect(out).toContain('olares-one-spec.pdf');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://ragflow.example/api/v1/retrieval');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.question).toBe('how does olares one ship?');
    expect(body.dataset_ids).toEqual(['ds_001']);
    expect(body.top_k).toBe(3);
    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.get('Authorization')).toBe('Bearer test-key');
  });

  it('refuses to search without a knowledge_base_id', async () => {
    const t = ragSearchTool({
      baseUrl: 'https://ragflow.example',
      apiKey: 'test-key',
    }) as { execute: (input: { query: string }, opts: unknown) => Promise<string> };
    const out = await t.execute({ query: 'no kb provided' }, {});
    expect(out).toMatch(/knowledge_base_id is required/);
  });

  it('surfaces RAGFlow non-zero codes verbatim', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      code: 102, message: 'dataset not found',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const t = ragSearchTool({
      baseUrl: 'https://ragflow.example',
      apiKey: 'test-key',
    }) as { execute: (input: { query: string; knowledge_base_id: string }, opts: unknown) => Promise<string> };
    const out = await t.execute({ query: 'x', knowledge_base_id: 'missing' }, {});
    expect(out).toContain('rag_search failed');
    expect(out).toContain('dataset not found');
  });
});
