// Integration test — hit `GET /gallery` against a seeded sqlite DB.
//
// We mount only the gallery router on a throwaway Express app, pre-seed
// the sqlite table via the repo, and verify the GET + DELETE response
// shapes. Wave F removed the auto-seed-from-ComfyUI path, so the test
// now simply asserts that routes serve the rows already in the DB
// without touching the network at all.

import { describe, expect, it, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import galleryRouter from '../../src/routes/gallery.routes.js';
import * as repo from '../../src/lib/db/gallery.repo.js';
import { useFreshDb } from '../lib/db/_helpers.js';
import { authedFetch } from '../helpers/authedFetch.js';

function startApp(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use(galleryRouter);
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

describe('GET /gallery (sqlite-backed)', () => {
  useFreshDb();

  beforeEach(() => {
    // Seed the DB so the routes see rows without hitting ComfyUI.
    for (let i = 0; i < 7; i++) {
      repo.insert({
        id: `p-${i}.png`,
        filename: `${i}.png`,
        subfolder: '',
        type: 'output',
        mediaType: i % 2 === 0 ? 'image' : 'video',
        url: `/api/view?filename=${i}.png`,
        promptId: 'p',
        createdAt: 1000 + i,
      });
    }
  });

  it('unpaginated: returns a flat array preserving GalleryItem shape', async () => {
    const app = await startApp();
    try {
      const res = await authedFetch(`${app.url}/gallery`);
      expect(res.status).toBe(200);
      const body = await res.json() as { data: { items: Array<Record<string, unknown>> } };
      const items = body.data.items;
      expect(Array.isArray(items)).toBe(true);
      expect(items.length).toBe(7);
      expect(items[0]).toHaveProperty('id');
      expect(items[0]).toHaveProperty('filename');
      expect(items[0]).toHaveProperty('mediaType');
      expect(items[0]).toHaveProperty('url');
    } finally { await app.close(); }
  });

  it('paginated: returns PageEnvelope with page/pageSize/total/hasMore', async () => {
    const app = await startApp();
    try {
      const res = await authedFetch(`${app.url}/gallery?page=1&pageSize=3`);
      expect(res.status).toBe(200);
      const body = await res.json() as {
        data: { items: unknown[]; page: number; pageSize: number; total: number; hasMore: boolean };
      };
      expect(body.data.page).toBe(1);
      expect(body.data.pageSize).toBe(3);
      expect(body.data.total).toBe(7);
      expect(body.data.items.length).toBe(3);
      expect(body.data.hasMore).toBe(true);
    } finally { await app.close(); }
  });

  it('paginated with mediaType filter applies before paging', async () => {
    const app = await startApp();
    try {
      const res = await authedFetch(`${app.url}/gallery?page=1&pageSize=50&mediaType=image`);
      const body = await res.json() as { data: { items: Array<{ mediaType: string }>; total: number } };
      expect(body.data.total).toBe(4);
      expect(body.data.items.every(r => r.mediaType === 'image')).toBe(true);
    } finally { await app.close(); }
  });

  it('DELETE /gallery/:id removes the sqlite row', async () => {
    const app = await startApp();
    try {
      const res = await authedFetch(`${app.url}/gallery/p-0.png`, { method: 'DELETE' });
      expect(res.status).toBe(200);
      const body = await res.json() as { data: { deleted: boolean; id: string } };
      expect(body.data.deleted).toBe(true);
      expect(body.data.id).toBe('p-0.png');
      expect(repo.count()).toBe(6);
    } finally { await app.close(); }
  });

  it('DELETE /gallery/:id returns 404 for an unknown id', async () => {
    const app = await startApp();
    try {
      const res = await authedFetch(`${app.url}/gallery/does-not-exist`, { method: 'DELETE' });
      expect(res.status).toBe(404);
      expect(repo.count()).toBe(7);
    } finally { await app.close(); }
  });

  it('DELETE /gallery with ids body bulk-deletes', async () => {
    const app = await startApp();
    try {
      const res = await authedFetch(`${app.url}/gallery`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: ['p-0.png', 'p-1.png', 'missing'] }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as {
        data: { deleted: number; requested: number; results: Array<{ id: string; removed: boolean }> };
      };
      expect(body.data.deleted).toBe(2);
      expect(body.data.requested).toBe(3);
      expect(body.data.results.find(r => r.id === 'missing')?.removed).toBe(false);
      expect(repo.count()).toBe(5);
    } finally { await app.close(); }
  });

  it('DELETE /gallery rejects empty body', async () => {
    const app = await startApp();
    try {
      const res = await authedFetch(`${app.url}/gallery`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [] }),
      });
      expect(res.status).toBe(400);
    } finally { await app.close(); }
  });
});
