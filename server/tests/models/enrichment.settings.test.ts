// NSFW blur level setting persistence tests.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Use importOriginal to avoid the CONFIG_FILE hoisting issue.
vi.mock('../../src/config/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/paths.js')>();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-settings-nsfw-'));
  const CONFIG_FILE = path.join(dir, 'config.json');
  // Store on the mock object so tests can access it.
  (globalThis as unknown as Record<string, unknown>).__TEST_NSFW_CONFIG__ = CONFIG_FILE;
  return {
    paths: { ...actual.paths, configFile: CONFIG_FILE },
  };
});

// Import AFTER mocks are declared.
import * as settings from '../../src/services/settings/index.js';

function configFile(): string {
  return (globalThis as unknown as Record<string, unknown>).__TEST_NSFW_CONFIG__ as string;
}

describe('nsfwBlurLevel setting', () => {
  beforeEach(() => {
    try { fs.unlinkSync(configFile()); } catch { /* ok */ }
    settings._saveInternal({});
  });

  it('default is 1 (PG13)', () => {
    expect(settings.getNsfwBlurLevel()).toBe(1);
  });

  it('persists after setNsfwBlurLevel', () => {
    settings.setNsfwBlurLevel(3);
    const raw = JSON.parse(fs.readFileSync(configFile(), 'utf8')) as { nsfwBlurLevel?: number };
    expect(raw.nsfwBlurLevel).toBe(3);
    expect(settings.getNsfwBlurLevel()).toBe(3);
  });

  it('ignores out-of-range values', () => {
    settings.setNsfwBlurLevel(2);
    expect(settings.getNsfwBlurLevel()).toBe(2);
    settings.setNsfwBlurLevel(99);
    settings.setNsfwBlurLevel(-1);
    expect(settings.getNsfwBlurLevel()).toBe(2);
  });

  it('accepts boundary value 0 (SFW only)', () => {
    settings.setNsfwBlurLevel(0);
    expect(settings.getNsfwBlurLevel()).toBe(0);
  });

  it('accepts boundary value 4 (no blur)', () => {
    settings.setNsfwBlurLevel(4);
    expect(settings.getNsfwBlurLevel()).toBe(4);
  });
});
