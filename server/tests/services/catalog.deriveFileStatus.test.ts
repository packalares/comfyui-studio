// Tests for deriveFileStatus tolerance fix (audit C7).
// A model whose actual size is within 1% (or 4 KB) of expected should not
// be flagged as 'incomplete' just because of filesystem block padding.

import { describe, it, expect, vi } from 'vitest';

// catalog/service.ts has many deps; mock the heavy ones so the module loads.
vi.mock('../../src/services/settings/index.js', () => ({
  getHfToken: vi.fn(() => null),
  getCivitaiToken: vi.fn(() => null),
  getGithubToken: vi.fn(() => null),
}));
vi.mock('../../src/services/models/enrichment/sidecar.js', () => ({
  readSidecar: vi.fn(() => null),
}));
vi.mock('../../src/lib/db/modelFiles.repo.js', () => ({
  listByFilename: vi.fn(() => []),
  listAll: vi.fn(() => []),
}));
vi.mock('../../src/services/catalog/store.js', () => ({
  load: vi.fn(() => ({ models: [] })),
  persist: vi.fn(),
  persistCurrent: vi.fn(),
  seedFromComfyUI: vi.fn(async () => {}),
  markInstalled: vi.fn(),
  markUninstalled: vi.fn(),
  markDownloadFailed: vi.fn(),
  findRow: vi.fn(() => undefined),
  findRowFromStore: vi.fn(() => undefined),
}));
vi.mock('../../src/services/catalog/urlSources.js', () => ({
  declaredByFor: vi.fn(() => []),
  mergeIntoExisting: vi.fn(),
  urlSourceFor: vi.fn(() => undefined),
}));
vi.mock('../../src/services/catalog/canonicalize.js', () => ({
  canonicalizeSync: vi.fn(),
}));
vi.mock('../../src/services/models/service.js', () => ({
  scanAndRefresh: vi.fn(async () => ({ count: 0, models: [] })),
}));
vi.mock('../../src/lib/http.js', () => ({
  getHostAuthHeaders: vi.fn(() => ({})),
}));
vi.mock('../../src/lib/events.js', () => ({
  on: vi.fn(),
  emit: vi.fn(),
  off: vi.fn(),
}));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { deriveFileStatus } = await import('../../src/services/catalog/service.js');

describe('deriveFileStatus tolerance (audit C7)', () => {
  it('reports complete when actual equals expected', () => {
    expect(deriveFileStatus(1_000_000, 1_000_000, true)).toBe('complete');
  });

  it('reports complete when actual is 0.1% smaller (block rounding)', () => {
    const expected = 1_000_000;
    const actual = Math.floor(expected * 0.999);
    expect(deriveFileStatus(expected, actual, true)).toBe('complete');
  });

  it('reports complete when difference is exactly 4096 bytes', () => {
    const expected = 1_000_000;
    expect(deriveFileStatus(expected, expected - 4096, true)).toBe('complete');
  });

  it('reports complete when difference is within 1% for large files', () => {
    const expected = 10_000_000;
    // 1% of 10MB = 100KB; 4096 < 100000, so tolerance is 100000.
    expect(deriveFileStatus(expected, expected - 99_000, true)).toBe('complete');
  });

  it('reports incomplete when actual is significantly smaller (> 1%)', () => {
    const expected = 10_000_000;
    const actual = expected - 200_000; // 2% short
    expect(deriveFileStatus(expected, actual, true)).toBe('incomplete');
  });

  it('returns null when not installed', () => {
    expect(deriveFileStatus(1_000_000, 1_000_000, false)).toBeNull();
  });

  it('returns null when expected size is 0', () => {
    expect(deriveFileStatus(0, 0, true)).toBeNull();
  });
});
