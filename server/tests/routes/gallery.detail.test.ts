// Integration test for `GET /api/gallery/:id` — the Wave P detail endpoint.
// Returns the full row with `workflowJson` + KSampler metadata on hit, 404
// when the id isn't in the repo.

import { describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import galleryRouter from '../../src/routes/gallery.routes.js';
import * as repo from '../../src/lib/db/gallery.repo.js';
import { useFreshDb } from '../lib/db/_helpers.js';

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
      const res = await fetch(`${app.url}/gallery/does-not-exist`);
      expect(res.status).toBe(404);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('not_found');
    } finally { await app.close(); }
  });

  it('returns the full row with fat metadata on hit', async () => {
    repo.insert({
      id: 'detail-1', filename: 'out.png', subfolder: '', type: 'output',
      mediaType: 'image', url: '/api/view?filename=out.png', promptId: 'p',
      createdAt: 1000,
      templateName: 'FluxDev',
      sizeBytes: 5555,
      workflowJson: JSON.stringify({ '5': { class_type: 'KSampler', inputs: { seed: 42 } } }),
      promptText: 'a photo',
      negativeText: 'bad',
      seed: 42,
      model: 'flux.safetensors',
      sampler: 'euler',
      steps: 20,
      cfg: 6,
      width: 1024,
      height: 1024,
    });
    const app = await startApp();
    try {
      const res = await fetch(`${app.url}/gallery/detail-1`);
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.id).toBe('detail-1');
      expect(body.filename).toBe('out.png');
      expect(body.templateName).toBe('FluxDev');
      expect(body.sizeBytes).toBe(5555);
      // Fat fields present.
      expect(body.workflowJson).toContain('KSampler');
      expect(body.promptText).toBe('a photo');
      expect(body.seed).toBe(42);
      expect(body.model).toBe('flux.safetensors');
      expect(body.sampler).toBe('euler');
      expect(body.steps).toBe(20);
      expect(body.cfg).toBe(6);
      expect(body.width).toBe(1024);
      expect(body.height).toBe(1024);
    } finally { await app.close(); }
  });

  it('launcher alias also responds', async () => {
    repo.insert({
      id: 'alias-1', filename: 'a.png', subfolder: '', type: 'output',
      mediaType: 'image', url: '/api/view?filename=a.png', promptId: 'p',
      createdAt: 2000,
    });
    const app = await startApp();
    try {
      const res = await fetch(`${app.url}/launcher/gallery/alias-1`);
      expect(res.status).toBe(200);
      const body = await res.json() as { id: string };
      expect(body.id).toBe('alias-1');
    } finally { await app.close(); }
  });
});
