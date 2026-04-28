// Tests for the new validators added in batch 1:
//   - validateGithubUrl: accepts release-asset URLs, rejects everything else.
//   - validateGenericUrl: accepts http(s), rejects file:// and malformed.
//   - detectDownloadHost: classifies github + generic in addition to hf+civitai.

import { describe, expect, it } from 'vitest';
import {
  validateGithubUrl, validateGenericUrl, detectDownloadHost,
} from '../../../src/services/models/download.service.js';

describe('validateGithubUrl', () => {
  it('accepts a canonical release-asset URL and parses the filename', () => {
    const r = validateGithubUrl('https://github.com/o/r/releases/download/v1/asset.bin');
    expect(r.isValid).toBe(true);
    expect(r.fileName).toBe('asset.bin');
  });

  it('decodes percent-escaped filenames', () => {
    const r = validateGithubUrl('https://github.com/o/r/releases/download/v1/file%20name.bin');
    expect(r.isValid).toBe(true);
    expect(r.fileName).toBe('file name.bin');
  });

  it('rejects a repo-root URL', () => {
    expect(validateGithubUrl('https://github.com/o/r').isValid).toBe(false);
  });

  it('rejects a /tree/ URL', () => {
    expect(validateGithubUrl('https://github.com/o/r/tree/main').isValid).toBe(false);
  });

  it('rejects a non-github host', () => {
    expect(validateGithubUrl('https://example.com/o/r/releases/download/v1/a.bin').isValid).toBe(false);
  });
});

describe('validateGenericUrl', () => {
  it('accepts http and https URLs', () => {
    expect(validateGenericUrl('https://example.com/file.bin').isValid).toBe(true);
    expect(validateGenericUrl('http://localhost/file.bin').isValid).toBe(true);
  });

  it('rejects non-http schemes', () => {
    expect(validateGenericUrl('file:///etc/passwd').isValid).toBe(false);
    expect(validateGenericUrl('ftp://example.com/x').isValid).toBe(false);
  });

  it('rejects malformed URLs', () => {
    expect(validateGenericUrl('not a url').isValid).toBe(false);
  });
});

describe('detectDownloadHost', () => {
  it('classifies github.com as github', () => {
    expect(detectDownloadHost('https://github.com/o/r/releases/download/v1/a.bin')).toBe('github');
  });

  it('falls back to generic for any other valid http(s) host', () => {
    expect(detectDownloadHost('https://example.com/foo')).toBe('generic');
  });

  it('returns null for non-http schemes', () => {
    expect(detectDownloadHost('file:///etc/passwd')).toBeNull();
  });
});
