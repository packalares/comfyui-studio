// Integration test for the regenerate route.
//
// We mount the gallery router on a throwaway Express app and stub `fetch`
// to intercept the outbound `/api/prompt` POST. This exercises the full
// route handler (param parsing → row lookup → workflowJson parse → seed
// randomise → submit) without needing a live ComfyUI.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
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

const SAMPLE_WORKFLOW = {
  '1': {
    class_type: 'CheckpointLoaderSimple',
    inputs: { ckpt_name: 'm.safetensors' },
  },
  '5': {
    class_type: 'KSampler',
    inputs: {
      seed: 777,
      steps: 20,
      cfg: 7,
      sampler_name: 'euler',
    },
  },
};

describe('POST /gallery/:id/regenerate', () => {
  useFreshDb();

  let originalFetch: typeof fetch;
  let submitted: Array<{ url: string; body: unknown }> = [];

  beforeEach(() => {
    submitted = [];
    originalFetch = global.fetch;
    // Only intercept outbound ComfyUI calls; let the test's own HTTP traffic
    // (the request it makes to the throwaway Express app) fall through to
    // the real fetch so Express can actually respond.
    global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/api/prompt')) {
        submitted.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : null });
        return new Response(
          JSON.stringify({ prompt_id: 'regen-123' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return originalFetch(url, init);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns 404 for unknown id', async () => {
    const app = await startApp();
    try {
      const res = await authedFetch(`${app.url}/gallery/does-not-exist/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(404);
    } finally { await app.close(); }
  });

  it('returns 400 when the row has no workflowJson', async () => {
    repo.insert({
      id: 'p-1.png', filename: '1.png', subfolder: '', type: 'output',
      mediaType: 'image', url: '/api/view?filename=1.png', promptId: 'p',
      createdAt: 1000,
      // workflowJson left undefined — pre-Wave-F-style row.
    });
    const app = await startApp();
    try {
      const res = await authedFetch(`${app.url}/gallery/p-1.png/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('validation_failed');
    } finally { await app.close(); }
  });

  it('submits the stored workflow and returns promptId on success', async () => {
    repo.insert({
      id: 'p-ok.png', filename: 'ok.png', subfolder: '', type: 'output',
      mediaType: 'image', url: '/api/view?filename=ok.png', promptId: 'p',
      createdAt: 2000,
      workflowJson: JSON.stringify(SAMPLE_WORKFLOW),
    });
    const app = await startApp();
    try {
      const res = await authedFetch(`${app.url}/gallery/p-ok.png/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { data: { promptId: string } };
      expect(body.data.promptId).toBe('regen-123');
      expect(submitted.length).toBe(1);
      expect(submitted[0].url).toContain('/api/prompt');
      const payload = submitted[0].body as { prompt: Record<string, unknown> };
      expect(payload.prompt).toBeDefined();
      // Seed preserved since randomizeSeed was not set.
      const prompt = payload.prompt as Record<string, { inputs?: Record<string, unknown> }>;
      expect(prompt['5']!.inputs!.seed).toBe(777);
    } finally { await app.close(); }
  });

  it('randomizes seed when randomizeSeed=true', async () => {
    repo.insert({
      id: 'p-rand.png', filename: 'rand.png', subfolder: '', type: 'output',
      mediaType: 'image', url: '/api/view?filename=rand.png', promptId: 'p',
      createdAt: 3000,
      workflowJson: JSON.stringify(SAMPLE_WORKFLOW),
    });
    const app = await startApp();
    try {
      const res = await authedFetch(`${app.url}/gallery/p-rand.png/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ randomizeSeed: true }),
      });
      expect(res.status).toBe(200);
      expect(submitted.length).toBe(1);
      const payload = submitted[0].body as { prompt: Record<string, { inputs?: Record<string, unknown> }> };
      expect(payload.prompt['5']!.inputs!.seed).not.toBe(777);
    } finally { await app.close(); }
  });

  it('returns 502 when ComfyUI queue submission fails', async () => {
    repo.insert({
      id: 'p-fail.png', filename: 'fail.png', subfolder: '', type: 'output',
      mediaType: 'image', url: '/api/view?filename=fail.png', promptId: 'p',
      createdAt: 4000,
      workflowJson: JSON.stringify(SAMPLE_WORKFLOW),
    });
    // Narrower mock — fail only the /api/prompt call; everything else
    // (including the test's own traffic to the Express app) passes through.
    global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/api/prompt')) {
        return new Response('queue error', { status: 500 });
      }
      return originalFetch(url, init);
    }) as unknown as typeof fetch;
    const app = await startApp();
    try {
      const res = await authedFetch(`${app.url}/gallery/p-fail.png/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(502);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('upstream_unavailable');
    } finally { await app.close(); }
  });
});
