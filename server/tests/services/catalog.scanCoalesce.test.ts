// T3: scan coalescing — two concurrent getMergedModels calls must share one
// underlying scanAndRefresh invocation, not fire two parallel scans.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-scan-coalesce-'));
const CATALOG_FILE = path.join(TMP, 'catalog.json');

vi.mock('../../src/config/paths.js', async (orig) => {
  const actual = (await orig()) as { paths: Record<string, unknown> };
  return { paths: { ...actual.paths, catalogFile: CATALOG_FILE } };
});

// Mock the models service to count how many times scanAndRefresh is called.
let scanCallCount = 0;
vi.mock('../../src/services/models/service.js', () => ({
  scanAndRefresh: () => {
    scanCallCount += 1;
    // Simulate some async work so concurrent calls overlap.
    return new Promise<[]>(resolve => setTimeout(() => resolve([]), 20));
  },
  toWireEntry: (m: unknown) => m,
}));

// Also mock modelFiles.listByFilename to avoid SQLite dependency.
vi.mock('../../src/lib/db/modelFiles.repo.js', () => ({
  listByFilename: () => [],
}));

const catalogStore = await import('../../src/services/catalog/store.js');
const catalogService = await import('../../src/services/catalog/service.js');

function reset(): void {
  try { if (fs.existsSync(CATALOG_FILE)) fs.unlinkSync(CATALOG_FILE); } catch { /* ignore */ }
  catalogStore.persist({ version: 1, models: [] });
  catalogService.bustScanCache();
  scanCallCount = 0;
}

describe('getMergedModels scan coalescing', () => {
  beforeEach(() => reset());
  afterEach(() => reset());

  it('two concurrent calls share a single underlying scan', async () => {
    // Fire two calls at the same time without awaiting.
    const [r1, r2] = await Promise.all([
      catalogService.getMergedModels(),
      catalogService.getMergedModels(),
    ]);
    // Both calls should succeed.
    expect(Array.isArray(r1)).toBe(true);
    expect(Array.isArray(r2)).toBe(true);
    // Only one scan should have been triggered.
    expect(scanCallCount).toBe(1);
  });

  it('returns cached result within TTL without re-scanning', async () => {
    await catalogService.getMergedModels();
    expect(scanCallCount).toBe(1);

    // Second call within TTL should reuse cache.
    await catalogService.getMergedModels();
    expect(scanCallCount).toBe(1);
  });

  it('bustScanCache forces a new scan on next call', async () => {
    await catalogService.getMergedModels();
    expect(scanCallCount).toBe(1);

    catalogService.bustScanCache();

    await catalogService.getMergedModels();
    expect(scanCallCount).toBe(2);
  });

  it('exports SCAN_CACHE_TTL_MS as a positive number', () => {
    expect(catalogService.SCAN_CACHE_TTL_MS).toBeGreaterThan(0);
  });
});
