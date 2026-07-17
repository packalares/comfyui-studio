// Security tests: path-traversal guards for D1 (resolveAbsoluteModelPath)
// and D5 (downloadHfRepo directory parameter).
//
// These tests exercise the safeResolve boundary directly. They do NOT spawn
// child processes or touch the filesystem beyond what safeResolve requires.

import { describe, expect, it, vi, beforeAll } from 'vitest';

// ── Mock env before any module under test is imported ─────────────────────────

const FAKE_COMFYUI = '/srv/comfyui';

vi.mock('../../src/config/env.js', () => ({
  env: new Proxy({} as Record<string, string>, {
    get(_t, prop: string): string {
      if (prop === 'COMFYUI_PATH') return FAKE_COMFYUI;
      return '';
    },
  }),
  currentProcessEnv: () => process.env,
  currentSqliteOverride: () => undefined,
  isProduction: () => false,
  autoResolveSearchEnabled: () => false,
}));

// ── Mock DB repo: no file is indexed so the fallback branch is always exercised

vi.mock('../../src/lib/db/modelFiles.repo.js', () => ({
  listByFilename: vi.fn(() => []),
  listAll: vi.fn(() => []),
  upsert: vi.fn(),
  remove: vi.fn(),
  deleteScannedBefore: vi.fn(),
}));

// ── Lazy imports (must come after vi.mock calls) ───────────────────────────────

const { resolveAbsoluteModelPath } =
  await import('../../src/services/models/install.js');
const { safeResolve } = await import('../../src/lib/fs.js');

// ── D1: resolveAbsoluteModelPath path-traversal (install.ts) ─────────────────

describe('D1 — resolveAbsoluteModelPath path-traversal guard', () => {
  it('rejects save_path that traverses above COMFYUI_PATH via models/ prefix', () => {
    expect(() =>
      resolveAbsoluteModelPath(
        { name: 'evil', save_path: 'models/../../../etc', filename: 'passwd', type: 'other', base_url: '' },
        'passwd',
      ),
    ).toThrow(/escapes/);
  });

  it('rejects bare save_path with traversal (e.g. "../../etc")', () => {
    expect(() =>
      resolveAbsoluteModelPath(
        { name: 'evil', save_path: '../../etc', filename: 'passwd', type: 'other', base_url: '' },
        'passwd',
      ),
    ).toThrow(/escapes/);
  });

  it('accepts a valid bare save_path "loras" and returns a path under COMFYUI_PATH', () => {
    const result = resolveAbsoluteModelPath(
      { name: 'my-lora', save_path: 'loras', filename: 'my.safetensors', type: 'lora', base_url: '' },
      'my.safetensors',
    );
    expect(result.startsWith(FAKE_COMFYUI + '/')).toBe(true);
    expect(result).toBe(`${FAKE_COMFYUI}/models/loras/my.safetensors`);
  });

  it('accepts a valid models/-prefixed save_path and stays under COMFYUI_PATH', () => {
    const result = resolveAbsoluteModelPath(
      { name: 'cp', save_path: 'models/checkpoints', filename: 'v1.ckpt', type: 'checkpoint', base_url: '' },
      'v1.ckpt',
    );
    expect(result.startsWith(FAKE_COMFYUI + '/')).toBe(true);
  });
});

// ── D5: downloadHfRepo directory path construction (download.ts) ───────────────
//
// downloadHfRepo is not exported and spawns a child process, so we test the
// equivalent path-building logic directly via safeResolve, mirroring what
// download.ts does at runtime.

function buildAbsDir(directory: string): string {
  const safeDir = directory.startsWith('models/') || directory.startsWith('custom_nodes/')
    ? directory
    : `models/${directory}`;
  return safeResolve(FAKE_COMFYUI, safeDir);
}

describe('D5 — downloadHfRepo directory path-traversal guard', () => {
  it('rejects directory = "../../../etc"', () => {
    expect(() => buildAbsDir('../../../etc')).toThrow(/escapes/);
  });

  it('rejects percent-decoded "..%2F..%2Fetc" (after URL decode)', () => {
    const decoded = decodeURIComponent('..%2F..%2Fetc');
    expect(() => buildAbsDir(decoded)).toThrow(/escapes/);
  });

  it('accepts a valid relative directory "myrepo"', () => {
    const result = buildAbsDir('myrepo');
    expect(result.startsWith(FAKE_COMFYUI + '/')).toBe(true);
    expect(result).toBe(`${FAKE_COMFYUI}/models/myrepo`);
  });

  it('accepts a models/-prefixed directory "models/checkpoints/myrepo"', () => {
    const result = buildAbsDir('models/checkpoints/myrepo');
    expect(result.startsWith(FAKE_COMFYUI + '/')).toBe(true);
  });
});
