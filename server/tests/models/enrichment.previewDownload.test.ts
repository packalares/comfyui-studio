// Tests for previewPathFor, hasLocalPreview, downloadPreviewFor.
//
// Sharp is mocked to avoid needing a native binary in CI; the tests verify
// the byte-cap, path-traversal guard, and happy-path write.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// --- Controlled mock state ---
let comfyuiPath = '';

vi.mock('../../src/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/env.js')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get COMFYUI_PATH() { return comfyuiPath; },
    },
  };
});

// Mock sharp: return a tiny 1x1 WebP buffer.
const TINY_WEBP = Buffer.from([
  0x52,0x49,0x46,0x46,0x24,0x00,0x00,0x00,0x57,0x45,0x42,0x50,
  0x56,0x50,0x38,0x4c,0x17,0x00,0x00,0x00,0x2f,0x00,0x00,0x00,
  0x00,0x00,0x00,0x00,0x00,0x00,0xfe,0x01,0x00,0x00,0x00,0x00,
  0x00,0x00,0x00,
]);

vi.mock('sharp', () => {
  const sharp = vi.fn(() => ({
    resize: vi.fn().mockReturnThis(),
    webp: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(TINY_WEBP),
  }));
  return { default: sharp };
});

// Mock network.js so settings module doesn't need DB.
vi.mock('../../src/services/settings/network.js', () => ({
  getHfEndpoint: () => '',
  getModelTrustedHosts: () => [],
}));

vi.mock('../../src/lib/security.js', () => ({
  hostIsPrivate: () => false,
  isHttpUrl: (url: string) => url.startsWith('http://') || url.startsWith('https://'),
}));

import { previewPathFor, hasLocalPreview, downloadPreviewFor } from '../../src/services/models/enrichment/previewDownload.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'studio-prevdl-'));
}

describe('previewPathFor', () => {
  it('returns sibling .preview.webp with same basename', () => {
    const result = previewPathFor('/models/loras/foo.safetensors');
    expect(result).toBe('/models/loras/foo.preview.webp');
  });

  it('handles model with no extension gracefully', () => {
    const result = previewPathFor('/models/loras/bar');
    expect(result).toBe('/models/loras/bar.preview.webp');
  });
});

describe('hasLocalPreview', () => {
  it('returns false when preview does not exist', async () => {
    const dir = tmpDir();
    const abs = path.join(dir, 'model.safetensors');
    fs.writeFileSync(abs, '');
    expect(await hasLocalPreview(abs)).toBe(false);
  });

  it('returns true when preview file exists', async () => {
    const dir = tmpDir();
    const abs = path.join(dir, 'model.safetensors');
    fs.writeFileSync(abs, '');
    fs.writeFileSync(path.join(dir, 'model.preview.webp'), TINY_WEBP);
    expect(await hasLocalPreview(abs)).toBe(true);
  });
});

describe('downloadPreviewFor', () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
    comfyuiPath = dir;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects path traversal (model path outside COMFYUI_PATH)', async () => {
    // absModelPath that would resolve outside the root.
    const absModel = '/etc/passwd';
    const result = await downloadPreviewFor(absModel, 'https://example.com/img.jpg');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/escapes/i);
  });

  it('writes a valid WebP file from a mocked image URL', async () => {
    const modelPath = path.join(dir, 'models', 'loras', 'test.safetensors');
    fs.mkdirSync(path.dirname(modelPath), { recursive: true });
    fs.writeFileSync(modelPath, '');

    // Provide a fake fetch response with image bytes.
    const fakeBody = Buffer.from([0xFF, 0xD8, 0xFF]); // JPEG header bytes
    const readable = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(fakeBody));
        controller.close();
      },
    });
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(readable, { status: 200 }));

    const result = await downloadPreviewFor(modelPath, 'https://civitai.com/img/preview.jpg');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.localPath).toMatch(/\.preview\.webp$/);
      expect(fs.existsSync(result.localPath)).toBe(true);
    }
  });

  it('respects maxBytes cap', async () => {
    const modelPath = path.join(dir, 'models', 'loras', 'big.safetensors');
    fs.mkdirSync(path.dirname(modelPath), { recursive: true });
    fs.writeFileSync(modelPath, '');

    const bigChunk = new Uint8Array(100);
    const readable = new ReadableStream({
      start(controller) {
        controller.enqueue(bigChunk);
        controller.close();
      },
    });
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(readable, { status: 200 }));

    const result = await downloadPreviewFor(
      modelPath,
      'https://civitai.com/img/big.jpg',
      { maxBytes: 50 }, // 100 bytes > 50 cap
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/maxBytes/i);
    }
  });

  it('returns error on HTTP non-200', async () => {
    const modelPath = path.join(dir, 'models', 'loras', 'err.safetensors');
    fs.mkdirSync(path.dirname(modelPath), { recursive: true });
    fs.writeFileSync(modelPath, '');

    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));

    const result = await downloadPreviewFor(modelPath, 'https://civitai.com/img/notfound.jpg');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/404/);
    }
  });
});
