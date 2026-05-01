// Integration test — hit `GET /plugins` and `POST /plugins/update-cache`
// against a seeded sqlite DB. No ComfyUI install state is present (PLUGIN_PATH
// is unset in the vitest env) so the overlay is a no-op and the rows come
// straight from the repo.

import { describe, expect, it, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import pluginsRouter from '../../src/routes/plugins.routes.js';
import * as repo from '../../src/lib/db/plugins.repo.js';
import * as cacheService from '../../src/services/plugins/cache.service.js';
import { useFreshDb } from '../lib/db/_helpers.js';

function startApp(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use(pluginsRouter);
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

describe('GET /plugins + POST /plugins/update-cache (sqlite-backed)', () => {
  useFreshDb();

  beforeEach(() => {
    cacheService.clearCache();
    repo.upsertMany([
      { id: 'alpha-node', name: 'Alpha', repository: 'https://github.com/x/alpha', description: 'first node' },
      { id: 'beta-node',  name: 'Beta',  repository: 'https://github.com/x/beta',  description: 'second node' },
      { id: 'gamma-node', name: 'Gamma', repository: 'https://github.com/x/gamma', description: 'third node' },
    ]);
  });

  it('unpaginated: returns flat array of catalog plugins', async () => {
    const app = await startApp();
    try {
      const res = await fetch(`${app.url}/plugins`);
      expect(res.status).toBe(200);
      const body = await res.json() as Array<Record<string, unknown>>;
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(3);
      expect(body[0]).toHaveProperty('id');
      expect(body[0]).toHaveProperty('name');
      expect(body[0]).toHaveProperty('installed');
    } finally { await app.close(); }
  });

  it('paginated: returns PageEnvelope with items/total/hasMore', async () => {
    const app = await startApp();
    try {
      const res = await fetch(`${app.url}/plugins?page=1&pageSize=2`);
      expect(res.status).toBe(200);
      const body = await res.json() as {
        items: unknown[]; page: number; pageSize: number; total: number; hasMore: boolean;
      };
      expect(body.page).toBe(1);
      expect(body.pageSize).toBe(2);
      expect(body.total).toBe(3);
      expect(body.items.length).toBe(2);
      expect(body.hasMore).toBe(true);
    } finally { await app.close(); }
  });

  it('paginated: q filter narrows by name substring', async () => {
    const app = await startApp();
    try {
      const res = await fetch(`${app.url}/plugins?page=1&pageSize=50&q=beta`);
      const body = await res.json() as {
        items: Array<{ id: string }>; total: number;
      };
      expect(body.total).toBe(1);
      expect(body.items[0].id).toBe('beta-node');
    } finally { await app.close(); }
  });

  it('POST /plugins/update-cache (alias for combined refresh) refreshes sqlite from mirror', async () => {
    const app = await startApp();
    try {
      // update-cache is now an alias for the combined refresh handler. It
      // tries upstream first, but in the vitest sandbox there's no network,
      // so it degrades to reseeding from the bundled mirror JSON. The
      // mirror file in `server/data/` has thousands of rows so the count
      // should be well above our 3 test rows either way.
      const res = await fetch(`${app.url}/plugins/update-cache`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json() as {
        success: boolean;
        catalogUpdated: boolean;
        upstreamError?: string;
        pluginsCount: number;
        installedCount: number;
      };
      expect(body.success).toBe(true);
      expect(typeof body.pluginsCount).toBe('number');
      // Whether or not upstream succeeded, sqlite should now reflect the
      // bundled mirror (~2800 nodes), wiping our 3-row seed.
      expect(body.pluginsCount).toBeGreaterThan(100);
      expect(repo.count()).toBeGreaterThan(100);
    } finally { await app.close(); }
  });
});
