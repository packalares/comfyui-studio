// POST /models/download-custom catalog pre-populate tests.
//
// Goals:
//   1. When the request carries `meta`, a catalog row with the rich metadata
//      (type, description, thumbnail, size, reference, gated flag) appears
//      immediately — before the download completes.
//   2. On successful completion the `downloading` flag flips to false; the
//      row stays in place so the Models page shows it as installed.
//   3. On failure the row keeps its metadata but gets an `error` stamp and
//      `downloading: false` so the UI can offer a retry.
//   4. When `meta` is absent, the endpoint still works (back-compat with
//      callers that don't yet thread metadata).

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import type { AddressInfo } from 'net';
import { authedFetch } from '../helpers/authedFetch.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-catalog-prepop-'));
const CATALOG_FILE = path.join(TMP, 'catalog.json');

// Point the catalog store at a tmpdir file so tests never touch real state.
vi.mock('../../src/config/paths.js', async (orig) => {
  const actual = (await orig()) as { paths: Record<string, unknown> };
  return {
    paths: {
      ...actual.paths,
      catalogFile: CATALOG_FILE,
    },
  };
});

// Stub the heavy download-path so the route handler returns quickly without
// touching the network or the real engine. We capture the args the service
// was invoked with so the test can inspect them.
const downloadCustomSpy = vi.hoisted(() => ({
  fn: vi.fn(async (_url: string, dir: string, _tokens: unknown, filename?: string) => ({
    taskId: 'task-1',
    fileName: filename || 'x.safetensors',
    saveDir: `models/${dir}`,
  })),
}));

vi.mock('../../src/services/models/service.js', () => ({
  downloadCustom: downloadCustomSpy.fn,
  scanAndRefresh: async () => [],
  toWireEntry: (m: unknown) => m,
}));

// Downloads tracker writes to an in-process Map; keep real module but no-op
// the pieces our route handler invokes so the test stays pure.
vi.mock('../../src/services/downloads/index.js', async (orig) => {
  const actual = await orig() as Record<string, unknown>;
  return {
    ...actual,
    trackDownload: vi.fn(),
    findByIdentity: () => undefined,
    findQueuedByIdentity: () => undefined,
    isAtCapacity: () => false,
    enqueueDownload: vi.fn(() => 'synth'),
  };
});

const modelsRoutes = (await import('../../src/routes/models.routes.js')).default;
const catalog = await import('../../src/services/catalog/index.js');
const catalogStore = await import('../../src/services/catalog/store.js');
const catalogEvents = await import('../../src/services/catalog/index.js');
const bus = await import('../../src/lib/events.js');

function startApp(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use('/api', modelsRoutes);
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

function resetCatalogFile(): void {
  try { if (fs.existsSync(CATALOG_FILE)) fs.unlinkSync(CATALOG_FILE); } catch { /* ignore */ }
  // In-process cache in catalogStore — reset by persisting an empty blob.
  catalogStore.persist({ version: 1, models: [] });
}

describe('POST /models/download-custom — catalog pre-populate', () => {
  beforeEach(() => {
    resetCatalogFile();
    bus.resetForTests();
    catalogEvents.rewireForTests();
    downloadCustomSpy.fn.mockClear();
  });

  afterEach(() => {
    bus.resetForTests();
  });

  it('writes a catalog row with full metadata at download start', async () => {
    const app = await startApp();
    try {
      const res = await authedFetch(`${app.url}/api/models/download-custom`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hfUrl: 'https://civitai.com/api/download/models/1234',
          modelDir: 'loras',
          modelName: 'Neat LoRA',
          filename: 'neat-lora.safetensors',
          meta: {
            type: 'LORA',
            description: 'A neat LoRA',
            reference: 'https://civitai.com/models/5678',
            size_bytes: 200 * 1024 * 1024,
            thumbnail: 'https://image.example/preview.png',
            gated: false,
            source: 'civitai',
          },
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { data: { success: boolean } };
      expect(body.data.success).toBe(true);

      const row = catalog.getModel('neat-lora.safetensors');
      expect(row).toBeDefined();
      expect(row?.name).toBe('Neat LoRA');
      expect(row?.type.toLowerCase()).toBe('lora');
      expect(row?.save_path).toBe('loras');
      expect(row?.description).toBe('A neat LoRA');
      expect(row?.reference).toBe('https://civitai.com/models/5678');
      expect(row?.thumbnail).toBe('https://image.example/preview.png');
      expect(row?.size_bytes).toBe(200 * 1024 * 1024);
      expect(row?.size_pretty.length).toBeGreaterThan(0);
      expect(row?.downloading).toBe(true);
      expect(row?.error).toBeUndefined();
      expect(row?.source).toBe('civitai');
    } finally { await app.close(); }
  });

  it('completes successfully: model:installed flips downloading to false', async () => {
    const app = await startApp();
    try {
      await authedFetch(`${app.url}/api/models/download-custom`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hfUrl: 'https://civitai.com/api/download/models/1234',
          modelDir: 'loras',
          filename: 'neat-lora.safetensors',
          meta: { type: 'LORA', thumbnail: 'https://image.example/x.png' },
        }),
      });
      expect(catalog.getModel('neat-lora.safetensors')?.downloading).toBe(true);

      bus.emit('model:installed', { filename: 'neat-lora.safetensors' });
      const row = catalog.getModel('neat-lora.safetensors');
      expect(row?.downloading).toBe(false);
      expect(row?.error).toBeUndefined();
      // Pre-populated metadata survives completion.
      expect(row?.thumbnail).toBe('https://image.example/x.png');
    } finally { await app.close(); }
  });

  it('on failure: row keeps metadata and is stamped with error', async () => {
    const app = await startApp();
    try {
      await authedFetch(`${app.url}/api/models/download-custom`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hfUrl: 'https://civitai.com/api/download/models/1234',
          modelDir: 'loras',
          filename: 'broken.safetensors',
          meta: { type: 'LORA', description: 'testing failure', source: 'civitai' },
        }),
      });
      expect(catalog.getModel('broken.safetensors')?.downloading).toBe(true);

      bus.emit('model:download-failed', {
        filename: 'broken.safetensors',
        error: 'HTTP 502 from upstream',
      });
      const row = catalog.getModel('broken.safetensors');
      expect(row?.downloading).toBe(false);
      expect(row?.error).toBe('HTTP 502 from upstream');
      expect(row?.description).toBe('testing failure');
      expect(row?.source).toBe('civitai');
    } finally { await app.close(); }
  });

  it('back-compat: request without `meta` still downloads', async () => {
    const app = await startApp();
    try {
      const res = await authedFetch(`${app.url}/api/models/download-custom`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hfUrl: 'https://civitai.com/api/download/models/1234',
          modelDir: 'checkpoints',
          filename: 'bare.safetensors',
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { data: { success: boolean } };
      expect(body.data.success).toBe(true);
      expect(downloadCustomSpy.fn).toHaveBeenCalledTimes(1);

      // Even without meta, the route still writes a minimal catalog row so
      // the Models page shows the in-flight entry. type falls back to 'other'.
      const row = catalog.getModel('bare.safetensors');
      expect(row).toBeDefined();
      // type is inferred from modelDir when meta is absent.
      expect(typeof row?.type).toBe('string');
      expect(row?.downloading).toBe(true);
      expect(row?.thumbnail).toBeUndefined();
      expect(row?.description).toBeUndefined();
    } finally { await app.close(); }
  });
});
