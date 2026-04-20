// Verify models.service.installFromCatalog selects URLs in the launcher's
// priority order (hf > mirror > cdn) by inspecting the in-memory catalog.

import { describe, expect, it, beforeEach } from 'vitest';
import * as tracker from '../../src/services/downloadController/progressTracker.js';
import { buildDownloadUrl } from '../../src/services/models/download.service.js';

describe('install URL selection order', () => {
  beforeEach(() => tracker.__resetForTests());

  it('launcher order: source=hf prefers hf', () => {
    const u = buildDownloadUrl({
      name: 'foo', save_path: 'x',
      url: { hf: 'H', mirror: 'M', cdn: 'C' },
    }, 'hf');
    expect(u).toBe('H');
  });

  it('launcher order: source=mirror prefers mirror', () => {
    const u = buildDownloadUrl({
      name: 'foo', save_path: 'x',
      url: { hf: 'H', mirror: 'M', cdn: 'C' },
    }, 'mirror');
    expect(u).toBe('M');
  });

  it('launcher order: source=cdn prefers cdn', () => {
    const u = buildDownloadUrl({
      name: 'foo', save_path: 'x',
      url: { hf: 'H', mirror: 'M', cdn: 'C' },
    }, 'cdn');
    expect(u).toBe('C');
  });

  it('falls back gracefully when primary absent', () => {
    const u = buildDownloadUrl({
      name: 'foo', save_path: 'x',
      url: { mirror: 'M' },
    }, 'hf');
    expect(u).toBe('M');
  });
});
