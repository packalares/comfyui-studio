// Tests for safeResolve path-traversal guard and statModelOnDisk's
// escape-resistance.

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { safeResolve, statModelOnDisk } from '../../src/lib/fs.js';

describe('safeResolve', () => {
  it('joins simple segments', () => {
    const root = '/tmp/foo';
    expect(safeResolve(root, 'bar', 'baz.txt')).toBe('/tmp/foo/bar/baz.txt');
  });

  it('rejects ../ traversal', () => {
    expect(() => safeResolve('/tmp/foo', '..', 'etc', 'passwd')).toThrow(/escapes/);
  });

  it('rejects absolute segment that escapes root', () => {
    expect(() => safeResolve('/tmp/foo', '/etc/passwd')).toThrow(/escapes/);
  });

  it('allows root itself', () => {
    expect(safeResolve('/tmp/foo')).toBe('/tmp/foo');
  });

  it('throws on empty root', () => {
    expect(() => safeResolve('')).toThrow(/empty root/);
  });
});

describe('statModelOnDisk', () => {
  it('returns null when root is empty', () => {
    expect(statModelOnDisk('', 'checkpoints', 'a.safetensors')).toBeNull();
  });

  it('returns null when saveDir is undefined', () => {
    expect(statModelOnDisk('/tmp', undefined, 'a.safetensors')).toBeNull();
  });

  it('returns null when saveDir escapes root (no leak of size outside root)', () => {
    // Even if /etc/passwd exists with a non-zero size, a saveDir of '../etc'
    // must be rejected by safeResolve and statModelOnDisk must return null.
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stat-test-'));
    try {
      expect(statModelOnDisk(tmpRoot, '../../etc', 'passwd')).toBeNull();
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('returns size for a real file under root', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stat-test-'));
    try {
      const sub = path.join(tmpRoot, 'checkpoints');
      fs.mkdirSync(sub);
      fs.writeFileSync(path.join(sub, 'a.safetensors'), 'hello world');
      expect(statModelOnDisk(tmpRoot, 'checkpoints', 'a.safetensors')).toBe(11);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
