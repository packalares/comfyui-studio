// Tests for the safeResolve path-traversal guard.

import { describe, expect, it } from 'vitest';
import { safeResolve } from '../../src/lib/fs.js';

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
