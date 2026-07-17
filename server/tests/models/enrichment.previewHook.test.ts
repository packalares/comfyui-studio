// Tests for registerPreviewHook: verifies the event bus subscription.
//
// Mocks downloadPreviewFor to check it's invoked when the event fires
// with a preview_remote_url and no existing preview_local_path.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Reset the bus between tests.
vi.mock('../../src/lib/events.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/events.js')>();
  return { ...actual };
});

// downloadPreviewFor mock — controllable per test.
const mockDownloadPreviewFor = vi.fn<
  [string, string, ({ maxBytes?: number; nsfwThreshold?: number } | undefined)?],
  Promise<{ ok: boolean; localPath?: string; bytes?: number; error?: string }>
>();

vi.mock('../../src/services/models/enrichment/previewDownload.js', () => ({
  downloadPreviewFor: (...args: Parameters<typeof mockDownloadPreviewFor>) =>
    mockDownloadPreviewFor(...args),
  previewPathFor: (p: string) => p.replace(/\.[^.]+$/, '') + '.preview.webp',
  hasLocalPreview: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import * as bus from '../../src/lib/events.js';
import { registerPreviewHook } from '../../src/services/models/enrichment/previewHook.js';
import { writeSidecar, readSidecar } from '../../src/services/models/enrichment/sidecar.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'studio-hook-'));
}

/** Wait for async fire-and-forget inside the hook handler. */
function flushAsync(): Promise<void> {
  return new Promise((r) => setTimeout(r, 10));
}

describe('registerPreviewHook', () => {
  beforeEach(() => {
    bus.resetForTests();
    mockDownloadPreviewFor.mockReset();
  });

  it('calls downloadPreviewFor when model:enriched fires with preview_remote_url', async () => {
    const dir = tmpDir();
    const absPath = path.join(dir, 'foo.safetensors');
    fs.writeFileSync(absPath, '');

    // Write a sidecar with remote URL but no local path.
    writeSidecar(absPath, {
      filename: 'foo.safetensors',
      save_path: 'loras',
      preview_remote_url: 'https://civitai.com/img/preview.jpg',
    });

    mockDownloadPreviewFor.mockResolvedValue({
      ok: true,
      localPath: path.join(dir, 'foo.preview.webp'),
      bytes: 100,
    });

    registerPreviewHook();

    bus.emit('model:enriched', {
      filename: 'foo.safetensors',
      save_path: 'loras',
      absPath,
    });

    await flushAsync();

    expect(mockDownloadPreviewFor).toHaveBeenCalledOnce();
    expect(mockDownloadPreviewFor).toHaveBeenCalledWith(
      absPath,
      'https://civitai.com/img/preview.jpg',
    );
  });

  it('does NOT call downloadPreviewFor when preview_local_path already set', async () => {
    const dir = tmpDir();
    const absPath = path.join(dir, 'bar.safetensors');
    fs.writeFileSync(absPath, '');

    writeSidecar(absPath, {
      filename: 'bar.safetensors',
      save_path: 'loras',
      preview_remote_url: 'https://civitai.com/img/preview.jpg',
      preview_local_path: 'bar.preview.webp',
    });

    registerPreviewHook();

    bus.emit('model:enriched', {
      filename: 'bar.safetensors',
      save_path: 'loras',
      absPath,
    });

    await flushAsync();

    expect(mockDownloadPreviewFor).not.toHaveBeenCalled();
  });

  it('does NOT call downloadPreviewFor when no preview_remote_url in sidecar', async () => {
    const dir = tmpDir();
    const absPath = path.join(dir, 'baz.safetensors');
    fs.writeFileSync(absPath, '');

    writeSidecar(absPath, {
      filename: 'baz.safetensors',
      save_path: 'loras',
    });

    registerPreviewHook();

    bus.emit('model:enriched', {
      filename: 'baz.safetensors',
      save_path: 'loras',
      absPath,
    });

    await flushAsync();

    expect(mockDownloadPreviewFor).not.toHaveBeenCalled();
  });

  it('updates sidecar preview_local_path on successful download', async () => {
    const dir = tmpDir();
    const absPath = path.join(dir, 'qux.safetensors');
    fs.writeFileSync(absPath, '');

    writeSidecar(absPath, {
      filename: 'qux.safetensors',
      save_path: 'loras',
      preview_remote_url: 'https://civitai.com/img/preview.jpg',
    });

    const localPath = path.join(dir, 'qux.preview.webp');
    mockDownloadPreviewFor.mockResolvedValue({ ok: true, localPath, bytes: 200 });

    registerPreviewHook();

    bus.emit('model:enriched', {
      filename: 'qux.safetensors',
      save_path: 'loras',
      absPath,
    });

    await flushAsync();

    const updated = readSidecar(absPath);
    expect(updated?.preview_local_path).toBe('qux.preview.webp');
  });
});
