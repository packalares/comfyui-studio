// SQLite-backed model-index integration: rebuildFullIndex walks a real
// tmpdir tree, syncOne adds a single row, removeOne deletes by absolute
// path, and orphan cleanup happens when the post-walk
// `deleteScannedBefore` pass runs.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as repo from '../../src/lib/db/modelFiles.repo.js';
import { useFreshDb } from '../lib/db/_helpers.js';

const state = vi.hoisted(() => ({
  comfyRoot: '',
  hubRoot: '',
}));

vi.mock('../../src/config/env.js', () => ({
  env: new Proxy({}, {
    get(_t, prop: string): unknown {
      if (prop === 'COMFYUI_PATH') return state.comfyRoot;
      if (prop === 'SHARED_MODEL_HUB_PATH') return state.hubRoot;
      return undefined;
    },
  }),
  currentSqliteOverride: () => process.env.STUDIO_SQLITE_PATH,
  currentProcessEnv: () => process.env,
  isProduction: () => false,
  autoResolveSearchEnabled: () => false,
}));

const { rebuildFullIndex, syncOne, removeOne } =
  await import('../../src/services/models/modelIndex.js');

describe('modelIndex.rebuildFullIndex', () => {
  useFreshDb();

  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-index-'));
    state.comfyRoot = path.join(tmpRoot, 'comfy');
    state.hubRoot = '';
    fs.mkdirSync(path.join(state.comfyRoot, 'models', 'checkpoints'), { recursive: true });
    fs.mkdirSync(path.join(state.comfyRoot, 'models', 'loras'), { recursive: true });
  });

  afterEach(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('walks every immediate subdir and indexes each model file', async () => {
    fs.writeFileSync(path.join(state.comfyRoot, 'models', 'checkpoints', 'a.safetensors'), 'aaaa');
    fs.writeFileSync(path.join(state.comfyRoot, 'models', 'loras', 'b.safetensors'), 'bbbbbb');
    const result = await rebuildFullIndex();
    expect(result.added).toBe(2);
    expect(result.total).toBe(2);
    expect(repo.has('a.safetensors')).toBe(true);
    expect(repo.has('b.safetensors')).toBe(true);
    const a = repo.findByDirAndName('checkpoints', 'a.safetensors');
    expect(a?.root_kind).toBe('local');
    expect(a?.top_dir).toBe('checkpoints');
    expect(a?.size).toBe(4);
    expect(a?.status).toBe('complete');
  });

  it('removes orphans on a subsequent rebuild', async () => {
    const fileA = path.join(state.comfyRoot, 'models', 'checkpoints', 'a.safetensors');
    fs.writeFileSync(fileA, 'aaaa');
    fs.writeFileSync(path.join(state.comfyRoot, 'models', 'loras', 'b.safetensors'), 'bbbbbb');
    await rebuildFullIndex();
    expect(repo.countAll()).toBe(2);

    fs.unlinkSync(fileA);
    const result = await rebuildFullIndex();
    expect(repo.countAll()).toBe(1);
    expect(repo.has('a.safetensors')).toBe(false);
    expect(repo.has('b.safetensors')).toBe(true);
    expect(result.removed).toBe(1);
  });

  it('skips unknown extensions', async () => {
    fs.writeFileSync(path.join(state.comfyRoot, 'models', 'checkpoints', 'README.md'), '# notes');
    fs.writeFileSync(path.join(state.comfyRoot, 'models', 'checkpoints', 'kept.safetensors'), 'data');
    const result = await rebuildFullIndex();
    expect(result.added).toBe(1);
    expect(repo.has('README.md')).toBe(false);
    expect(repo.has('kept.safetensors')).toBe(true);
  });

  it('also walks the shared hub when configured', async () => {
    state.hubRoot = path.join(tmpRoot, 'hub');
    fs.mkdirSync(path.join(state.hubRoot, 'main'), { recursive: true });
    fs.writeFileSync(path.join(state.hubRoot, 'main', 'shared.safetensors'), 'xx');
    fs.writeFileSync(path.join(state.comfyRoot, 'models', 'checkpoints', 'local.safetensors'), 'yy');
    const result = await rebuildFullIndex();
    expect(result.added).toBe(2);
    const shared = repo.listByFilename('shared.safetensors')[0];
    expect(shared?.root_kind).toBe('hub');
    expect(shared?.top_dir).toBe('main');
    const local = repo.listByFilename('local.safetensors')[0];
    expect(local?.root_kind).toBe('local');
  });
});

describe('modelIndex.syncOne / removeOne', () => {
  useFreshDb();

  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-index-'));
    state.comfyRoot = path.join(tmpRoot, 'comfy');
    state.hubRoot = '';
    fs.mkdirSync(path.join(state.comfyRoot, 'models', 'checkpoints'), { recursive: true });
  });

  afterEach(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('syncOne stats and inserts a single file', async () => {
    const abs = path.join(state.comfyRoot, 'models', 'checkpoints', 'one.safetensors');
    fs.writeFileSync(abs, 'hello');
    await syncOne(abs);
    const hit = repo.findByDirAndName('checkpoints', 'one.safetensors');
    expect(hit).not.toBeNull();
    expect(hit?.size).toBe(5);
    expect(hit?.root_kind).toBe('local');
  });

  it('syncOne is a no-op when the file no longer exists', async () => {
    const abs = path.join(state.comfyRoot, 'models', 'checkpoints', 'gone.safetensors');
    await syncOne(abs);
    expect(repo.countAll()).toBe(0);
  });

  it('removeOne drops by absolute path', async () => {
    const abs = path.join(state.comfyRoot, 'models', 'checkpoints', 'drop.safetensors');
    fs.writeFileSync(abs, 'data');
    await syncOne(abs);
    expect(repo.countAll()).toBe(1);
    removeOne(abs);
    expect(repo.countAll()).toBe(0);
  });
});
