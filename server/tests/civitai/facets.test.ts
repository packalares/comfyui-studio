// /civitai/models/facets returns:
//   - types/periods/sorts: hardcoded constants the UI reads from the server
//     so chip lists are never re-declared on the client.
//   - baseModels: probed off CivitAI's Most-Downloaded slice — distinct
//     `modelVersions[0].baseModel` values, sorted, deduped, cached for 1h.
//
// The probe-failure path falls back to a small hardcoded list so the UI
// never breaks; that case is covered by the third test below.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import civitaiRoutes from '../../src/routes/civitai.routes.js';
import { authedFetch } from '../helpers/authedFetch.js';
import { _resetBaseModelsCache, CIVITAI_BASE_MODELS_FALLBACK } from '../../src/services/civitai/facets.js';

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

describe('GET /civitai/models/facets', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    _resetBaseModelsCache();
  });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('extracts distinct baseModels from CivitAI most-downloaded slice', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (/civitai\.com\/api\/v1\/models/.test(url)) {
        return jsonResponse({
          items: [
            { id: 1, name: 'a', modelVersions: [{ baseModel: 'SDXL 1.0' }] },
            { id: 2, name: 'b', modelVersions: [{ baseModel: 'SD 1.5' }] },
            { id: 3, name: 'c', modelVersions: [{ baseModel: 'SDXL 1.0' }] }, // dedup
            { id: 4, name: 'd', modelVersions: [{ baseModel: 'Pony' }] },
          ],
          metadata: {},
        });
      }
      return originalFetch(input as RequestInfo, init);
    }) as typeof fetch;

    const app = await startApp();
    try {
      const res = await authedFetch(`${app.url}/civitai/models/facets`);
      expect(res.status).toBe(200);
      const body = await res.json() as {
        data: { types: string[]; baseModels: string[]; periods: string[]; sorts: string[] };
      };
      // baseModels: distinct + alphabetically sorted.
      expect(body.data.baseModels).toEqual(['Pony', 'SD 1.5', 'SDXL 1.0']);
      // Static constants are present.
      expect(body.data.types).toContain('LORA');
      expect(body.data.types).toContain('Checkpoint');
      expect(body.data.periods).toEqual(['AllTime', 'Year', 'Month', 'Week', 'Day']);
      expect(body.data.sorts).toEqual(['Highest Rated', 'Most Downloaded', 'Newest']);
    } finally { await app.close(); }
  });

  it('falls back to a hardcoded baseModels list when the upstream probe fails', async () => {
    // Only fail civitai.com requests — authedFetch needs the loopback ones.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (/civitai\.com\/api\/v1\/models/.test(url)) {
        throw new Error('simulated upstream failure');
      }
      return originalFetch(input as RequestInfo, init);
    }) as typeof fetch;

    const app = await startApp();
    try {
      const res = await authedFetch(`${app.url}/civitai/models/facets`);
      expect(res.status).toBe(200);
      const body = await res.json() as { data: { baseModels: string[] } };
      // Returns the fallback list verbatim.
      expect(body.data.baseModels).toEqual(Array.from(CIVITAI_BASE_MODELS_FALLBACK));
    } finally { await app.close(); }
  });
});
