// Tests the Wave J expectation that /civitai/models/search returns a
// PageEnvelope carrying `hasMore` and `nextCursor`. The legacy /latest and
// /hot endpoints were removed when CivitAI browse was unified onto faceted
// search; their tests folded into the search case here.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import civitaiRoutes from '../../src/routes/civitai.routes.js';
import { authedFetch } from '../helpers/authedFetch.js';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function startApp(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use(civitaiRoutes);
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

describe('civitai search route envelope shape', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('/civitai/models/search returns hasMore + items', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (/civitai\.com\/api\/v1\/models/.test(url)) {
        return jsonResponse({
          items: [{ id: 1, name: 'row' }],
          metadata: { currentPage: 1, pageSize: 24, nextPage: 'https://civitai.com/api/v1/models?page=2' },
        });
      }
      return originalFetch(input as RequestInfo, init);
    }) as typeof fetch;

    const app = await startApp();
    try {
      const res = await authedFetch(`${app.url}/civitai/models/search?q=sd`);
      expect(res.status).toBe(200);
      const body = await res.json() as {
        data: { items: Array<{ id: number }>; hasMore: boolean; total: number; page: number; pageSize: number };
      };
      expect(body.data.items).toHaveLength(1);
      expect(body.data.hasMore).toBe(true);
      expect(typeof body.data.total).toBe('number');
    } finally { await app.close(); }
  });

  it('/civitai/models/search surfaces nextCursor when civitai returns one', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (/civitai\.com\/api\/v1\/models/.test(url)) {
        return jsonResponse({
          items: [{ id: 99 }],
          metadata: { nextCursor: 'abc123', pageSize: 24 },
        });
      }
      return originalFetch(input as RequestInfo, init);
    }) as typeof fetch;

    const app = await startApp();
    try {
      const res = await authedFetch(`${app.url}/civitai/models/search?q=sd`);
      expect(res.status).toBe(200);
      const body = await res.json() as { data: { hasMore: boolean; nextCursor?: string } };
      expect(body.data.hasMore).toBe(true);
      expect(body.data.nextCursor).toBe('abc123');
    } finally { await app.close(); }
  });

  it('hasMore is false when metadata exposes no cursor/nextPage', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (/civitai\.com\/api\/v1\/models/.test(url)) {
        return jsonResponse({
          items: [{ id: 7 }],
          metadata: { currentPage: 1, pageSize: 24 },
        });
      }
      return originalFetch(input as RequestInfo, init);
    }) as typeof fetch;

    const app = await startApp();
    try {
      const res = await authedFetch(`${app.url}/civitai/models/search?q=sd`);
      expect(res.status).toBe(200);
      const body = await res.json() as { data: { hasMore: boolean; nextCursor?: string } };
      expect(body.data.hasMore).toBe(false);
      expect(body.data.nextCursor).toBeUndefined();
    } finally { await app.close(); }
  });
});
