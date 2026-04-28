// CivitAI-flavoured unit tests for the unified /models/download-custom
// machinery. These cover URL validation + host detection + auth-header
// selection. The actual fetch is NOT exercised here — `downloadModelByName`
// is an HTTP call whose network side-effects live behind the progress
// tracker, and the route-handler tests in server/tests/integration cover
// that path.

import { describe, expect, it } from 'vitest';
import {
  validateCivitaiUrl, detectDownloadHost,
} from '../../src/services/models/download.service.js';
import {
  getHfAuthHeaders, getCivitaiAuthHeaders, getHostAuthHeaders,
} from '../../src/lib/http.js';

describe('validateCivitaiUrl', () => {
  it('accepts canonical civitai download url', () => {
    const r = validateCivitaiUrl('https://civitai.com/api/download/models/2811282');
    expect(r.isValid).toBe(true);
  });

  it('accepts www.civitai.com variant', () => {
    const r = validateCivitaiUrl('https://www.civitai.com/api/download/models/123');
    expect(r.isValid).toBe(true);
  });

  it('rejects civitai non-download paths', () => {
    const r = validateCivitaiUrl('https://civitai.com/models/376130');
    expect(r.isValid).toBe(false);
    expect(r.error).toMatch(/\/api\/download\/models\//);
  });

  it('rejects non-civitai hosts', () => {
    const r = validateCivitaiUrl('https://example.com/api/download/models/1');
    expect(r.isValid).toBe(false);
    expect(r.error).toMatch(/civitai\.com/);
  });

  it('rejects malformed URLs', () => {
    expect(validateCivitaiUrl('not a url').isValid).toBe(false);
  });
});

describe('detectDownloadHost', () => {
  it('classifies huggingface.co', () => {
    expect(detectDownloadHost('https://huggingface.co/foo/bar'))
      .toBe('huggingface');
  });

  it('classifies hf-mirror.com as huggingface', () => {
    expect(detectDownloadHost('https://hf-mirror.com/foo/bar'))
      .toBe('huggingface');
  });

  it('classifies civitai.com', () => {
    expect(detectDownloadHost('https://civitai.com/api/download/models/1'))
      .toBe('civitai');
  });

  it('classifies github.com release URLs', () => {
    expect(detectDownloadHost('https://github.com/foo/bar/releases/download/v1/asset.bin'))
      .toBe('github');
  });

  it('classifies any other valid http(s) host as generic', () => {
    // After the urlSources / generic-streamer work, the dispatcher does
    // not reject an arbitrary host here — the route-level allow-list
    // (services/models/downloadAllowlist.ts) is the gate, while the host
    // detector just labels the URL family for the unified-download
    // dispatcher.
    expect(detectDownloadHost('https://example.com/x')).toBe('generic');
  });

  it('returns null for malformed URLs', () => {
    expect(detectDownloadHost('not a url')).toBeNull();
  });

  it('returns null for non-http(s) schemes', () => {
    expect(detectDownloadHost('file:///etc/passwd')).toBeNull();
  });
});

describe('auth header selection (host-aware)', () => {
  it('getHfAuthHeaders emits Bearer for HF + token present', () => {
    expect(getHfAuthHeaders('https://huggingface.co/foo', 'hftok'))
      .toEqual({ Authorization: 'Bearer hftok' });
  });

  it('getHfAuthHeaders is empty for civitai URL even if token supplied', () => {
    expect(getHfAuthHeaders('https://civitai.com/api/download/models/1', 'hftok'))
      .toEqual({});
  });

  it('getCivitaiAuthHeaders emits Bearer for civitai + token', () => {
    expect(getCivitaiAuthHeaders('https://civitai.com/api/download/models/1', 'civtok'))
      .toEqual({ Authorization: 'Bearer civtok' });
  });

  it('getCivitaiAuthHeaders is empty for HF URL', () => {
    expect(getCivitaiAuthHeaders('https://huggingface.co/foo', 'civtok'))
      .toEqual({});
  });

  it('getHostAuthHeaders picks HF token for HF URL', () => {
    expect(getHostAuthHeaders(
      'https://huggingface.co/foo',
      { hfToken: 'H', civitaiToken: 'C' },
    )).toEqual({ Authorization: 'Bearer H' });
  });

  it('getHostAuthHeaders picks civitai token for civitai URL', () => {
    expect(getHostAuthHeaders(
      'https://civitai.com/api/download/models/1',
      { hfToken: 'H', civitaiToken: 'C' },
    )).toEqual({ Authorization: 'Bearer C' });
  });

  it('getHostAuthHeaders returns empty for unsupported hosts', () => {
    expect(getHostAuthHeaders(
      'https://example.com/x',
      { hfToken: 'H', civitaiToken: 'C' },
    )).toEqual({});
  });
});
