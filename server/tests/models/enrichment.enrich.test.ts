// enrichOne: skip_metadata_refresh + user field preservation.
// vi.mock must be at top level; shared mock state is controlled via closures.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeSidecar, readSidecar } from '../../src/services/models/enrichment/sidecar.js';

// ---- Controlled mock state ----
// The modelFiles mock is set up at the top level and the `currentAbsPath` variable
// is updated per test so `listByFilename` returns the correct row.

let currentAbsPath = '';

vi.mock('../../src/lib/db/modelFiles.repo.js', () => ({
  listByFilename: () => currentAbsPath
    ? [{ abs_path: currentAbsPath, rel_path: 'loras/test.safetensors', sha256: null, status: 'complete', size: 5 }]
    : [],
  listMissingSha256: () => [],
  setSha256: vi.fn(),
}));

// CivitAI searchByHash always returns null (not found) in these tests.
vi.mock('../../src/services/models/enrichment/CivitaiModelSource.js', () => ({
  civitaiSource: { searchByHash: async () => null },
  CivitaiModelSource: class { searchByHash = async (): Promise<null> => null; },
}));

vi.mock('../../src/lib/http.js', () => ({
  fetchWithRetry: vi.fn().mockRejectedValue(new Error('should not be called')),
  getHostAuthHeaders: () => ({}),
  getHfAuthHeaders: () => ({}),
  getCivitaiAuthHeaders: () => ({}),
  getGithubAuthHeaders: () => ({}),
}));

vi.mock('../../src/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/env.js')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      COMFYUI_PATH: '/tmp/fake-comfy-enrich',
      CIVITAI_API_BASE: 'https://civitai.com/api/v1',
      CIVITAI_MAX_RESPONSE_BYTES: 10 * 1024 * 1024,
    },
  };
});

vi.mock('../../src/services/settings/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/settings/index.js')>();
  return { ...actual, getCivitaiToken: () => undefined };
});

vi.mock('../../src/lib/events.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/events.js')>();
  return { ...actual, emit: vi.fn() };
});

vi.mock('../../src/services/catalog/store.js', () => ({
  findRowFromStore: () => undefined,
  load: () => ({ version: 1, models: [] }),
  persist: vi.fn(),
  findRow: () => undefined,
}));

vi.mock('../../src/services/catalog/service.js', () => ({
  upsertModel: vi.fn(),
  getAllModels: () => [],
}));

vi.mock('../../src/services/models/enrichment/verifyUrls.js', () => ({
  verifyUrlSources: async () => [],
}));

// Import AFTER mocks.
import { enrichOne } from '../../src/services/models/enrichment/enrich.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'studio-enrich-test-'));
}

// ---- Tests ----

describe('enrichOne — skip_metadata_refresh', () => {
  beforeEach(() => { currentAbsPath = ''; });

  it('returns unchanged sidecar when skip_metadata_refresh is true', async () => {
    const dir = tmpDir();
    const absModel = path.join(dir, 'skip.safetensors');
    fs.writeFileSync(absModel, 'fake content');
    currentAbsPath = absModel;

    writeSidecar(absModel, {
      filename: 'skip.safetensors',
      save_path: 'loras',
      skip_metadata_refresh: true,
      trigger_words: ['original'],
      favorite: true,
      notes: 'should not change',
    });

    const result = await enrichOne({ save_path: 'loras', filename: 'skip.safetensors' });

    expect(result?.skip_metadata_refresh).toBe(true);
    expect(result?.trigger_words).toEqual(['original']);
    expect(result?.notes).toBe('should not change');

    // Sidecar must be unchanged.
    const onDisk = readSidecar(absModel);
    expect(onDisk?.trigger_words).toEqual(['original']);
    expect(onDisk?.favorite).toBe(true);
  });
});

describe('enrichOne — user field preservation', () => {
  beforeEach(() => { currentAbsPath = ''; });

  it('preserves favorite, notes, usage_tips after CivitAI not found', async () => {
    const dir = tmpDir();
    const absModel = path.join(dir, 'preserve.safetensors');
    fs.writeFileSync(absModel, 'content for preservation test');
    currentAbsPath = absModel;

    writeSidecar(absModel, {
      filename: 'preserve.safetensors',
      save_path: 'loras',
      favorite: true,
      notes: 'my personal note',
      usage_tips: 'use at 0.8',
      // No skip_metadata_refresh — enrichment should run.
    });

    const result = await enrichOne({ save_path: 'loras', filename: 'preserve.safetensors' });

    expect(result?.favorite).toBe(true);
    expect(result?.notes).toBe('my personal note');
    expect(result?.usage_tips).toBe('use at 0.8');
    // Enrichment ran (civitai deleted since not found).
    expect(result?.civitai_deleted).toBe(true);
  });
});
