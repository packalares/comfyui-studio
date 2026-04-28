// Tests for the unified-download allow-list helper.
//
// Coverage:
//   - Built-in hosts (HF/civitai/github + www variants) are accepted.
//   - Operator-added hosts (live setting) are accepted at runtime.
//   - Hosts not on either list are rejected.
//   - Private/loopback hosts are rejected even when on the allow-list.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as liveSettings from '../../../src/services/systemLauncher/liveSettings.js';
import {
  isAllowedDownloadHost, validateAllowedUrl, urlEncodesFilename,
} from '../../../src/services/models/downloadAllowlist.js';

describe('isAllowedDownloadHost', () => {
  beforeEach(() => { liveSettings.setModelTrustedHosts([]); });
  afterEach(() => { liveSettings.setModelTrustedHosts([]); });

  it('accepts the built-in trio + github', () => {
    expect(isAllowedDownloadHost('https://huggingface.co/x')).toBe(true);
    expect(isAllowedDownloadHost('https://hf-mirror.com/x')).toBe(true);
    expect(isAllowedDownloadHost('https://civitai.com/api/download/models/1')).toBe(true);
    expect(isAllowedDownloadHost('https://github.com/o/r/releases/download/v1/a.bin')).toBe(true);
  });

  it('rejects a generic host when no operator override is set', () => {
    expect(isAllowedDownloadHost('https://example.com/x')).toBe(false);
  });

  it('accepts an operator-added host after setModelTrustedHosts', () => {
    liveSettings.setModelTrustedHosts(['example.com']);
    expect(isAllowedDownloadHost('https://example.com/x')).toBe(true);
  });

  it('rejects malformed URLs', () => {
    expect(isAllowedDownloadHost('not a url')).toBe(false);
  });
});

describe('validateAllowedUrl', () => {
  beforeEach(() => { liveSettings.setModelTrustedHosts([]); });
  afterEach(() => { liveSettings.setModelTrustedHosts([]); });

  it('rejects non-http(s) URLs', () => {
    const r = validateAllowedUrl('file:///etc/passwd');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('http(s)');
  });

  it('rejects loopback hosts even when otherwise allow-listed', () => {
    liveSettings.setModelTrustedHosts(['localhost']);
    const r = validateAllowedUrl('http://localhost/file');
    expect(r.ok).toBe(false);
  });

  it('accepts a built-in host with a valid URL', () => {
    expect(validateAllowedUrl('https://huggingface.co/x/y').ok).toBe(true);
  });
});

describe('urlEncodesFilename', () => {
  it('returns false for civitai (no filename in path)', () => {
    expect(urlEncodesFilename('https://civitai.com/api/download/models/1')).toBe(false);
  });
  it('returns true for HF (filename in last segment)', () => {
    expect(urlEncodesFilename('https://huggingface.co/x/y/resolve/main/file.bin')).toBe(true);
  });
  it('returns true for github releases', () => {
    expect(urlEncodesFilename('https://github.com/o/r/releases/download/v1/a.bin')).toBe(true);
  });
});
