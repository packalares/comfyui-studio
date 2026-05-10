// Integration — POST /templates/import/github — verifies the end-to-end
// path through the new route + the remote-staging service. The network is
// stubbed by swapping `globalThis.fetch`.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import templatesImportRemote from '../../src/routes/templates.import.js';

function tinyWorkflow(): Record<string, unknown> {
  return {
    nodes: [
      { id: 1, type: 'KSampler' },
      { id: 2, type: 'SaveImage' },
    ],
  };
}

function startApp(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use(templatesImportRemote);
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

describe('POST /templates/import/github', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('stages a raw-file GitHub URL and returns a manifest', async () => {
    // Only stub GitHub hosts — the test client fetch to 127.0.0.1:<port>
    // must still reach the real Express app.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (/githubusercontent\.com|api\.github\.com/.test(url)) {
        return new Response(JSON.stringify(tinyWorkflow()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return originalFetch(input as RequestInfo, init);
    }) as typeof fetch;

    const app = await startApp();
    try {
      const res = await fetch(`${app.url}/templates/import/github`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url: 'https://github.com/alice/pack/blob/main/a.json',
        }),
      });
      const bodyText = await res.text();
      if (res.status !== 200) throw new Error(`status=${res.status} body=${bodyText}`);
      const body = JSON.parse(bodyText) as {
        id: string; workflows: Array<{ entryName: string; nodeCount: number }>;
      };
      expect(body.id).toBeTruthy();
      expect(body.workflows).toHaveLength(1);
      expect(body.workflows[0].nodeCount).toBe(2);
    } finally { await app.close(); }
  });

  it('returns 400 for a missing url field', async () => {
    const app = await startApp();
    try {
      const res = await fetch(`${app.url}/templates/import/github`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toMatch(/url/i);
    } finally { await app.close(); }
  });

  it('returns 400 for a host outside the allow-list', async () => {
    const app = await startApp();
    try {
      const res = await fetch(`${app.url}/templates/import/github`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://evil.example.com/a.json' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toMatch(/Host not allowed/);
    } finally { await app.close(); }
  });

  it('returns 400 for a private-host URL', async () => {
    const app = await startApp();
    try {
      const res = await fetch(`${app.url}/templates/import/github`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'http://127.0.0.1/a.json' }),
      });
      expect(res.status).toBe(400);
    } finally { await app.close(); }
  });
});
