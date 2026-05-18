// Tests for the unified-download URL validator + the host-membership helper.
//
// Coverage:
//   - `isAllowedDownloadHost` still recognises the built-in hosts (HF +
//     mirror, civitai, github, Drive trio) plus operator-added hosts.
//   - `validateAllowedUrl` is now permissive: any non-private http(s) URL
//     passes (the host allow-list was removed in 2026-05 to mirror the
//     paste-URL resolver, which content-checks URLs via HEAD-probe at
//     resolve time and therefore doesn't need a second host gate).
//   - Private/loopback hosts are still rejected regardless of host list.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as liveSettings from '../../../src/services/settings/network.js';
import {
  isAllowedDownloadHost, validateAllowedUrl, urlEncodesFilename,
} from '../../../src/services/models/downloadUrl.js';

describe('isAllowedDownloadHost', () => {
  beforeEach(() => { liveSettings.setModelTrustedHosts([]); });
  afterEach(() => { liveSettings.setModelTrustedHosts([]); });

  it('accepts the built-in trio + github + drive', () => {
    expect(isAllowedDownloadHost('https://huggingface.co/x')).toBe(true);
    expect(isAllowedDownloadHost('https://hf-mirror.com/x')).toBe(true);
    expect(isAllowedDownloadHost('https://civitai.com/api/download/models/1')).toBe(true);
    expect(isAllowedDownloadHost('https://github.com/o/r/releases/download/v1/a.bin')).toBe(true);
    expect(isAllowedDownloadHost('https://drive.google.com/uc?id=abc')).toBe(true);
    expect(isAllowedDownloadHost('https://docs.google.com/uc?id=abc')).toBe(true);
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

  it('accepts non-built-in public hosts (allow-list dropped 2026-05)', () => {
    // Regression pin: pre-2026-05 these would have returned ok=false with
    // "hfUrl host not allowed". The paste-URL resolver now content-checks
    // any URL at resolve time, so the download validator only enforces
    // SSRF + http(s).
    expect(validateAllowedUrl('https://example.com/some-file.safetensors').ok).toBe(true);
    expect(validateAllowedUrl('https://cdn.somerandom.host/4xFFHQDAT.pth').ok).toBe(true);
    expect(validateAllowedUrl('https://drive.google.com/uc?export=download&id=abc').ok).toBe(true);
  });

  it('still rejects private/loopback hosts regardless of allow-list', () => {
    expect(validateAllowedUrl('http://127.0.0.1/x').ok).toBe(false);
    expect(validateAllowedUrl('http://10.0.0.5/x').ok).toBe(false);
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
