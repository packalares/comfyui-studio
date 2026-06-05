// Integration test for `GET /api/gallery/:id` — the Wave P detail endpoint.
// Returns the full row with `workflowJson` + KSampler metadata on hit, 404
// when the id isn't in the repo.

import { describe, expect, it } from 'vitest';
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

describe('GET /gallery/:id', () => {
  useFreshDb();

  it('returns 404 on miss', async () => {
    const app = await startApp();
    try {
      const res = await authedFetch(`${app.url}/gallery/does-not-exist`);
      expect(res.status).toBe(404);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('not_found');
    } finally { await app.close(); }
  });

  it('returns the full row with fat metadata on hit', async () => {
    // v21: extracted fields no longer stored as DB columns — the route parses
    // workflowJson on-the-fly. Use a full workflow with KSampler + CLIPTextEncode
    // so extractMetadata can recover promptText, seed, sampler, steps, cfg.
    const workflowJson = JSON.stringify({
      '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'flux.safetensors' } },
      '2': { class_type: 'CLIPTextEncode', inputs: { text: 'a photo' } },
      '3': { class_type: 'CLIPTextEncode', inputs: { text: 'bad' } },
      '4': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024 } },
      '5': {
        class_type: 'KSampler',
        inputs: {
          seed: 42, steps: 20, cfg: 6, sampler_name: 'euler',
          positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0],
        },
      },
    });
    repo.insert({
      id: 'detail-1', filename: 'out.png', subfolder: '', type: 'output',
      mediaType: 'image', url: '/api/view?filename=out.png', promptId: 'p',
      createdAt: 1000,
      templateName: 'FluxDev',
      sizeBytes: 5555,
      workflowJson,
    });
    const app = await startApp();
    try {
      const res = await authedFetch(`${app.url}/gallery/detail-1`);
      expect(res.status).toBe(200);
      const env = await res.json() as { data: Record<string, unknown> };
      const body = env.data;
      expect(body.id).toBe('detail-1');
      expect(body.filename).toBe('out.png');
      expect(body.templateName).toBe('FluxDev');
      expect(body.sizeBytes).toBe(5555);
      // workflowJson and workflowHash are storage-only after v21; the wire
      // shape exposes a `workflowDetail` bundle instead, derived on the fly.
      expect(body.workflowJson).toBeUndefined();
      expect(body.workflowHash).toBeUndefined();
      const wd = body.workflowDetail as Record<string, unknown>;
      expect(wd).toBeDefined();
      expect(wd.promptText).toBe('a photo');
      expect(wd.seed).toBe(42);
      expect(wd.model).toBe('flux.safetensors');
      expect(wd.sampler).toBe('euler');
      expect(wd.steps).toBe(20);
      expect(wd.cfg).toBe(6);
      expect(wd.width).toBe(1024);
      expect(wd.height).toBe(1024);
    } finally { await app.close(); }
  });

  it('responds on the canonical path', async () => {
    repo.insert({
      id: 'alias-1', filename: 'a.png', subfolder: '', type: 'output',
      mediaType: 'image', url: '/api/view?filename=a.png', promptId: 'p',
      createdAt: 2000,
    });
    const app = await startApp();
    try {
      const res = await authedFetch(`${app.url}/gallery/alias-1`);
      expect(res.status).toBe(200);
      const body = await res.json() as { data: { id: string } };
      expect(body.data.id).toBe('alias-1');
    } finally { await app.close(); }
  });

  it('single row has null prevId and nextId', async () => {
    repo.insert({
      id: 'solo-1', filename: 'solo.png', subfolder: '', type: 'output',
      mediaType: 'image', url: '/api/view?filename=solo.png', promptId: '',
      createdAt: 5000,
    });
    const app = await startApp();
    try {
      const res = await authedFetch(`${app.url}/gallery/solo-1`);
      expect(res.status).toBe(200);
      const body = await res.json() as { data: { prevId: unknown; nextId: unknown } };
      expect(body.data.prevId).toBeNull();
      expect(body.data.nextId).toBeNull();
    } finally { await app.close(); }
  });
});
