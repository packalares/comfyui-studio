// Integration — POST /templates/import/civitai (Wave J URL-based import).
// Fetch is stubbed so the test doesn't hit civitai.com.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import templatesImportCivitai from '../../src/routes/templates.importCivitai.js';

function workflow(): Record<string, unknown> {
  return {
    nodes: [
      { id: 1, type: 'KSampler' },
      { id: 2, type: 'SaveImage' },
    ],
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function startApp(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use(templatesImportCivitai);
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

describe('POST /templates/import/civitai (URL-based)', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('stages a workflow from a /models/<id> URL', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (/civitai\.com\/api\/v1\/models\/777/.test(url)) {
        return jsonResponse({
          id: 777,
          name: 'X',
          modelVersions: [
            {
              id: 1,
              files: [
                { name: 'wf.json', type: 'Workflow', downloadUrl: 'https://civitai.com/api/download/1' },
              ],
            },
          ],
        });
      }
      if (/civitai\.com\/api\/download\/1/.test(url)) {
        return jsonResponse(workflow());
      }
      // Pass through the local test-server loopback fetch.
      return originalFetch(input as RequestInfo, init);
    }) as typeof fetch;

    const app = await startApp();
    try {
      const res = await fetch(`${app.url}/templates/import/civitai`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://civitai.com/models/777' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as {
        id: string;
        workflows: Array<unknown>;
        civitaiMeta?: { modelId: number };
      };
      expect(body.id).toBeTruthy();
      expect(body.workflows).toHaveLength(1);
      expect(body.civitaiMeta?.modelId).toBe(777);
    } finally { await app.close(); }
  });

  it('returns 400 for a missing url field', async () => {
    const app = await startApp();
    try {
      const res = await fetch(`${app.url}/templates/import/civitai`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    } finally { await app.close(); }
  });

  it('returns 400 for a URL that is not CivitAI-hosted', async () => {
    const app = await startApp();
    try {
      const res = await fetch(`${app.url}/templates/import/civitai`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/models/1' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { code?: string };
      expect(body.code).toBe('UNSUPPORTED_URL');
    } finally { await app.close(); }
  });

  it('returns 422 when no workflow found', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (/civitai\.com\/api\/v1\/models\/800/.test(url)) {
        return jsonResponse({
          id: 800,
          name: 'No workflow',
          modelVersions: [
            {
              id: 10,
              files: [{ name: 'w.safetensors', type: 'Model' }],
              images: [{ url: 'https://cdn/x.jpg' }],
            },
          ],
        });
      }
      return originalFetch(input as RequestInfo, init);
    }) as typeof fetch;

    const app = await startApp();
    try {
      const res = await fetch(`${app.url}/templates/import/civitai`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://civitai.com/models/800' }),
      });
      expect(res.status).toBe(422);
      const body = await res.json() as { code?: string };
      expect(body.code).toBe('NO_WORKFLOW_FOUND');
    } finally { await app.close(); }
  });
});
