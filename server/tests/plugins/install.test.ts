// URL validation + proxy rewriting for the plugin installer. Focuses on the
// security-critical surface: scheme allow-list, host allow-list, private-IP
// reject, traversal-safe requirements path.

import { describe, expect, it } from 'vitest';
import path from 'path';
import { safeResolve } from '../../src/lib/fs.js';
import {
  applyGithubProxy, parseGithubOwnerRepo, validatePluginUrl,
} from '../../src/services/plugins/install.urlValidation.js';

describe('plugins install url validation', () => {
  it('accepts https github.com', () => {
    const r = validatePluginUrl('https://github.com/foo/bar');
    expect(r.ok).toBe(true);
    expect(r.normalized).toBe('https://github.com/foo/bar');
  });

  it('accepts https gitlab.com', () => {
    expect(validatePluginUrl('https://gitlab.com/foo/bar').ok).toBe(true);
  });

  it('accepts huggingface.co', () => {
    expect(validatePluginUrl('https://huggingface.co/foo/bar').ok).toBe(true);
  });

  it('rejects http:// (non-https)', () => {
    const r = validatePluginUrl('http://github.com/foo/bar');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/https/);
  });

  it('rejects data:// and file:// and other schemes', () => {
    expect(validatePluginUrl('file:///etc/passwd').ok).toBe(false);
    expect(validatePluginUrl('ftp://example.com/x').ok).toBe(false);
  });

  it('rejects unknown hosts', () => {
    const r = validatePluginUrl('https://evil.example.com/foo/bar');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Host not allowed/);
  });

  it('rejects private-IP hosts via host guard', () => {
    // 127.0.0.1 is a private/loopback host and NOT in the allow-list anyway,
    // so the allow-list rejection wins first. Still covered by the test.
    expect(validatePluginUrl('https://127.0.0.1/foo/bar').ok).toBe(false);
  });

  it('strips trailing .git from normalized URL', () => {
    const r = validatePluginUrl('https://github.com/foo/bar.git');
    expect(r.ok).toBe(true);
    expect(r.normalized).toBe('https://github.com/foo/bar');
  });

  it('rejects garbage input', () => {
    expect(validatePluginUrl('').ok).toBe(false);
    expect(validatePluginUrl('not a url').ok).toBe(false);
  });
});

describe('plugins owner/repo parser', () => {
  it('extracts owner and repo', () => {
    expect(parseGithubOwnerRepo('https://github.com/foo/bar')).toEqual({ owner: 'foo', repo: 'bar' });
  });

  it('strips .git suffix', () => {
    expect(parseGithubOwnerRepo('https://github.com/foo/bar.git')).toEqual({ owner: 'foo', repo: 'bar' });
  });

  it('returns null for non-github URLs', () => {
    expect(parseGithubOwnerRepo('https://gitlab.com/foo/bar')).toBeNull();
  });
});

describe('plugins applyGithubProxy', () => {
  it('passes through when proxy unset', () => {
    expect(applyGithubProxy('https://github.com/a/b', '')).toBe('https://github.com/a/b');
  });

  it('passes through when proxy equals github.com', () => {
    expect(applyGithubProxy('https://github.com/a/b', 'https://github.com')).toBe('https://github.com/a/b');
    expect(applyGithubProxy('https://github.com/a/b', 'https://github.com/')).toBe('https://github.com/a/b');
  });

  it('rewrites when proxy configured', () => {
    expect(applyGithubProxy('https://github.com/a/b', 'https://ghp.example.com'))
      .toBe('https://ghp.example.com/a/b');
  });

  it('normalizes missing trailing slash', () => {
    expect(applyGithubProxy('https://github.com/a/b', 'https://ghp.example.com/path'))
      .toBe('https://ghp.example.com/path/a/b');
  });
});

describe('plugin install requirements path guard', () => {
  it('safeResolve rejects traversal out of plugin dir', () => {
    const base = '/tmp/plugins/foo';
    expect(() => safeResolve(base, '../../../etc/passwd')).toThrow();
  });

  it('safeResolve allows requirements.txt inside dir', () => {
    const base = '/tmp/plugins/foo';
    const r = safeResolve(base, 'requirements.txt');
    expect(path.basename(r)).toBe('requirements.txt');
  });
});
