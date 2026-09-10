import { describe, expect, it } from 'vitest';
import path from 'path';
import { sanitizeSegment, validateFilename, resolveWithin } from '../../src/lib/pathSafe.js';

const ROOT = path.resolve('/srv/comfy/input');

describe('sanitizeSegment', () => {
  it('passes normal segments', () => {
    expect(sanitizeSegment('img.png')).toBe('img.png');
    expect(sanitizeSegment('sub/dir')).toBe('sub/dir'); // multi-part allowed here
  });
  it('maps undefined to empty', () => {
    expect(sanitizeSegment(undefined)).toBe('');
  });
  it('rejects traversal, NUL and absolute', () => {
    expect(sanitizeSegment('../etc')).toBeNull();
    expect(sanitizeSegment('a\0b')).toBeNull();
    expect(sanitizeSegment('/etc/passwd')).toBeNull();
    expect(sanitizeSegment('C:\\win')).toBeNull();
  });
});

describe('validateFilename', () => {
  it('accepts a single component', () => {
    expect(validateFilename('lora.safetensors')).toBe('lora.safetensors');
  });
  it('rejects separators, dots, NUL, empty, absolute', () => {
    expect(validateFilename('a/b')).toBeNull();
    expect(validateFilename('a\\b')).toBeNull();
    expect(validateFilename('..')).toBeNull();
    expect(validateFilename('.')).toBeNull();
    expect(validateFilename('')).toBeNull();
    expect(validateFilename('x\0')).toBeNull();
    expect(validateFilename('/abs')).toBeNull();
  });
});

describe('resolveWithin', () => {
  it('composes a contained path', () => {
    expect(resolveWithin(ROOT, 'sub', 'img.png')).toBe(path.join(ROOT, 'sub', 'img.png'));
    expect(resolveWithin(ROOT, '', 'img.png')).toBe(path.join(ROOT, 'img.png'));
    expect(resolveWithin(ROOT, 'a/b', 'c.png')).toBe(path.join(ROOT, 'a', 'b', 'c.png'));
  });
  it('returns root itself when no file segment', () => {
    expect(resolveWithin(ROOT)).toBe(ROOT);
  });
  it('blocks traversal in any part', () => {
    expect(resolveWithin(ROOT, '..', 'x')).toBeNull();
    expect(resolveWithin(ROOT, 'a/../../b', 'x')).toBeNull();
    expect(resolveWithin(ROOT, 'sub', '../../etc/passwd')).toBeNull();
  });
  it('blocks absolute override and NUL', () => {
    expect(resolveWithin(ROOT, '/etc', 'passwd')).toBeNull();
    expect(resolveWithin(ROOT, 'sub', 'x\0.png')).toBeNull();
  });
  it('returns null for empty root', () => {
    expect(resolveWithin(undefined, 'x')).toBeNull();
    expect(resolveWithin('', 'x')).toBeNull();
  });
  it('a sibling directory sharing a prefix does not count as inside', () => {
    // /srv/comfy/input-evil must not resolve as inside /srv/comfy/input
    const escaped = resolveWithin(ROOT, '../input-evil', 'x');
    expect(escaped).toBeNull();
  });
});
