// Tests for HuggingFace .cache exclusion fix (audit C6).
// A directory tree containing .cache/blobs/something.safetensors must NOT
// appear in the scan result.

import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../../src/config/env.js', () => ({
  env: {
    COMFYUI_PATH: '/tmp/fake-comfyui',
    SHARED_MODEL_HUB: '',
    MODEL_STORAGE_EXTRA_DIRS: '',
    NODE_ENV: 'test',
  },
}));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { scanDirectory } = await import('../../src/services/models/installScan.js');

// Build a temporary tree:
//   <tmp>/
//     models/
//       loras/
//         real_model.safetensors   <- should be indexed
//         .cache/
//           blobs/
//             cached.safetensors   <- should NOT be indexed
let TMP_DIR = '';

beforeAll(() => {
  TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-scan-dot-cache-'));
  const lorasDir = path.join(TMP_DIR, 'models', 'loras');
  const cacheDir = path.join(lorasDir, '.cache', 'blobs');
  fs.mkdirSync(lorasDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(lorasDir, 'real_model.safetensors'), 'fake safetensors data');
  fs.writeFileSync(path.join(cacheDir, 'cached.safetensors'), 'fake cache blob data');
});

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('scanDirectory .cache exclusion (audit C6)', () => {
  it('indexes real model files but not .cache/ entries', async () => {
    const result = new Map<string, { filename: string }>();
    await scanDirectory(path.join(TMP_DIR, 'models', 'loras'), result, TMP_DIR);

    const filenames = [...result.values()].map((v) => v.filename);
    expect(filenames).toContain('real_model.safetensors');
    expect(filenames).not.toContain('cached.safetensors');
  });

  it('does not traverse into dot-prefixed directories', async () => {
    const result = new Map<string, { filename: string }>();
    await scanDirectory(path.join(TMP_DIR, 'models'), result, TMP_DIR);

    const keys = [...result.keys()];
    const cacheEntries = keys.filter((k) => k.includes('.cache'));
    expect(cacheEntries).toHaveLength(0);
  });
});
