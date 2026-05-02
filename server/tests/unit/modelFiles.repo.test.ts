// Round-trip tests for the SQLite-backed model_files repository.
//
// Each `it` runs against a fresh tmpdir DB via `useFreshDb` so no state
// leaks. The repo is the single source of truth for "is this filename on
// disk?" — exercise insert/upsert/query/delete + the `deleteScannedBefore`
// orphan-cleanup primitive used by the rebuild walker.

import { describe, expect, it } from 'vitest';
import * as repo from '../../src/lib/db/modelFiles.repo.js';
import { useFreshDb } from '../lib/db/_helpers.js';

function row(over: Partial<repo.ModelFileRow> = {}): repo.ModelFileRow {
  return {
    abs_path: '/root/ComfyUI/models/checkpoints/foo.safetensors',
    filename: 'foo.safetensors',
    rel_path: 'checkpoints/foo.safetensors',
    root_kind: 'local',
    top_dir: 'checkpoints',
    size: 1024,
    status: 'complete',
    scanned_at: 1000,
    ...over,
  };
}

describe('model_files repo', () => {
  useFreshDb();

  it('upsert inserts then refreshes scanned_at on a second call', () => {
    repo.upsert(row({ scanned_at: 1000 }));
    expect(repo.countAll()).toBe(1);
    repo.upsert(row({ scanned_at: 2000, size: 2048 }));
    expect(repo.countAll()).toBe(1);
    const hit = repo.findByDirAndName('checkpoints', 'foo.safetensors');
    expect(hit).not.toBeNull();
    expect(hit?.scanned_at).toBe(2000);
    expect(hit?.size).toBe(2048);
  });

  it('has / hasComplete reflect status filter', () => {
    repo.upsert(row({
      abs_path: '/r/incomplete.safetensors',
      filename: 'incomplete.safetensors',
      rel_path: 'checkpoints/incomplete.safetensors',
      status: 'incomplete',
    }));
    expect(repo.has('incomplete.safetensors')).toBe(true);
    expect(repo.hasComplete('incomplete.safetensors')).toBe(false);
    repo.upsert(row({
      abs_path: '/r/done.safetensors',
      filename: 'done.safetensors',
      rel_path: 'checkpoints/done.safetensors',
      status: 'complete',
    }));
    expect(repo.hasComplete('done.safetensors')).toBe(true);
  });

  it('listByFilename returns every row sharing a basename', () => {
    repo.upsert(row({
      abs_path: '/local/checkpoints/dup.safetensors',
      rel_path: 'checkpoints/dup.safetensors',
      filename: 'dup.safetensors',
      root_kind: 'local',
    }));
    repo.upsert(row({
      abs_path: '/hub/main/dup.safetensors',
      rel_path: 'main/dup.safetensors',
      filename: 'dup.safetensors',
      root_kind: 'hub',
      top_dir: 'main',
    }));
    const hits = repo.listByFilename('dup.safetensors');
    expect(hits.length).toBe(2);
    const kinds = hits.map((h) => h.root_kind).sort();
    expect(kinds).toEqual(['hub', 'local']);
  });

  it('listKnownTopDirs returns each distinct top_dir once', () => {
    repo.upsert(row({ abs_path: '/r/a.safetensors', filename: 'a.safetensors', rel_path: 'checkpoints/a.safetensors', top_dir: 'checkpoints' }));
    repo.upsert(row({ abs_path: '/r/b.safetensors', filename: 'b.safetensors', rel_path: 'checkpoints/b.safetensors', top_dir: 'checkpoints' }));
    repo.upsert(row({ abs_path: '/r/c.safetensors', filename: 'c.safetensors', rel_path: 'loras/c.safetensors', top_dir: 'loras' }));
    expect(repo.listKnownTopDirs()).toEqual(new Set(['checkpoints', 'loras']));
  });

  it('removeByAbsPath drops one row, leaves siblings', () => {
    repo.upsert(row({ abs_path: '/r/keep.safetensors', filename: 'keep.safetensors', rel_path: 'checkpoints/keep.safetensors' }));
    repo.upsert(row({ abs_path: '/r/drop.safetensors', filename: 'drop.safetensors', rel_path: 'checkpoints/drop.safetensors' }));
    repo.removeByAbsPath('/r/drop.safetensors');
    expect(repo.countAll()).toBe(1);
    expect(repo.has('keep.safetensors')).toBe(true);
    expect(repo.has('drop.safetensors')).toBe(false);
  });

  it('deleteScannedBefore removes only stale rows', () => {
    repo.upsert(row({ abs_path: '/r/old.safetensors', filename: 'old.safetensors', rel_path: 'checkpoints/old.safetensors', scanned_at: 100 }));
    repo.upsert(row({ abs_path: '/r/new.safetensors', filename: 'new.safetensors', rel_path: 'checkpoints/new.safetensors', scanned_at: 500 }));
    const removed = repo.deleteScannedBefore(300);
    expect(removed).toBe(1);
    expect(repo.has('old.safetensors')).toBe(false);
    expect(repo.has('new.safetensors')).toBe(true);
  });

  it('oldestScannedAt returns null on empty, MIN otherwise', () => {
    expect(repo.oldestScannedAt()).toBeNull();
    repo.upsert(row({ abs_path: '/r/a.safetensors', filename: 'a.safetensors', rel_path: 'checkpoints/a.safetensors', scanned_at: 100 }));
    repo.upsert(row({ abs_path: '/r/b.safetensors', filename: 'b.safetensors', rel_path: 'checkpoints/b.safetensors', scanned_at: 500 }));
    expect(repo.oldestScannedAt()).toBe(100);
  });

  it('listAll returns every row', () => {
    repo.upsert(row({ abs_path: '/r/a.safetensors', filename: 'a.safetensors', rel_path: 'checkpoints/a.safetensors' }));
    repo.upsert(row({ abs_path: '/r/b.safetensors', filename: 'b.safetensors', rel_path: 'loras/b.safetensors', top_dir: 'loras' }));
    const rows = repo.listAll();
    expect(rows.length).toBe(2);
    const filenames = rows.map((r) => r.filename).sort();
    expect(filenames).toEqual(['a.safetensors', 'b.safetensors']);
  });

  it('deleteAll empties the table', () => {
    repo.upsert(row());
    repo.deleteAll();
    expect(repo.countAll()).toBe(0);
  });
});
