// Integration test — hit `GET /plugins` against a seeded sqlite DB. No
// ComfyUI install state is present (PLUGIN_PATH is unset in the vitest env)
// so the overlay is a no-op and the rows come straight from the repo.

import { describe, expect, it, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import pluginsRouter from '../../src/routes/plugins.routes.js';
import * as repo from '../../src/lib/db/plugins.repo.js';
import * as cacheService from '../../src/services/plugins/cache.js';
import { useFreshDb } from '../lib/db/_helpers.js';
import { authedFetch } from '../helpers/authedFetch.js';

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

describe('GET /plugins (sqlite-backed)', () => {
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
      const res = await authedFetch(`${app.url}/plugins`);
      expect(res.status).toBe(200);
      const body = await res.json() as { data: { items: Array<Record<string, unknown>> } };
      const items = body.data.items;
      expect(Array.isArray(items)).toBe(true);
      expect(items.length).toBe(3);
      expect(items[0]).toHaveProperty('id');
      expect(items[0]).toHaveProperty('name');
      expect(items[0]).toHaveProperty('installed');
    } finally { await app.close(); }
  });

  it('paginated: returns PageEnvelope with items/total/hasMore', async () => {
    const app = await startApp();
    try {
      const res = await authedFetch(`${app.url}/plugins?page=1&pageSize=2`);
      expect(res.status).toBe(200);
      const body = await res.json() as {
        data: { items: unknown[]; page: number; pageSize: number; total: number; hasMore: boolean };
      };
      expect(body.data.page).toBe(1);
      expect(body.data.pageSize).toBe(2);
      expect(body.data.total).toBe(3);
      expect(body.data.items.length).toBe(2);
      expect(body.data.hasMore).toBe(true);
    } finally { await app.close(); }
  });

  it('paginated: q filter narrows by name substring', async () => {
    const app = await startApp();
    try {
      const res = await authedFetch(`${app.url}/plugins?page=1&pageSize=50&q=beta`);
      const body = await res.json() as {
        data: { items: Array<{ id: string }>; total: number };
      };
      expect(body.data.total).toBe(1);
      expect(body.data.items[0].id).toBe('beta-node');
    } finally { await app.close(); }
  });

});
