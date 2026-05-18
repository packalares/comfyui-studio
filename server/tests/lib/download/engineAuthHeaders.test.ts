// Unit tests for the engine's cross-host Authorization stripping helper.
//
// `filterAuthHeadersForHost` mirrors fetch's default `redirect: 'follow'`
// behaviour: Authorization is dropped when the target host differs from
// the original. Without this, the engine leaked the caller-supplied
// Bearer onto pre-signed CDN URLs (CivitAI → R2, HF LFS → CloudFront)
// whose AWS-Sig-V4 query-string auth is sufficient and which reject
// foreign Bearer headers with 400 Bad Request.

import { describe, expect, it } from 'vitest';
import { filterAuthHeadersForHost } from '../../../src/lib/download/engine.js';

describe('filterAuthHeadersForHost', () => {
  it('keeps Authorization when host matches', () => {
    const out = filterAuthHeadersForHost(
      { Authorization: 'Bearer civitai-token' },
      'https://civitai.com/api/download/models/1',
      'https://civitai.com/api/download/models/1',
    );
    expect(out).toEqual({ Authorization: 'Bearer civitai-token' });
  });

  it('strips Authorization on cross-host redirect target', () => {
    // The exact bug: CivitAI 307s to R2 signed URL, engine bleeds Bearer.
    const out = filterAuthHeadersForHost(
      { Authorization: 'Bearer civitai-token' },
      'https://civitai.com/api/download/models/1',
      'https://civitai-delivery-worker-prod.r2.cloudflarestorage.com/model/a.safetensors?X-Amz-Signature=abc',
    );
    expect(out).toEqual({});
  });

  it('keeps non-Authorization headers on cross-host redirect', () => {
    // Custom headers (e.g. User-Agent) are not host-scoped; only the
    // Bearer is.
    const out = filterAuthHeadersForHost(
      { Authorization: 'Bearer x', 'X-Custom': 'keep-me' },
      'https://huggingface.co/file',
      'https://cdn-lfs.huggingface.co/file',
    );
    expect(out).toEqual({ 'X-Custom': 'keep-me' });
  });

  it('subdomain change is treated as cross-host (matches fetch behaviour)', () => {
    // huggingface.co → cdn-lfs.huggingface.co IS a cross-host redirect
    // by hostname equality. HF LFS works without the Bearer (the redirect
    // URL is pre-signed), so this is the safe default.
    const out = filterAuthHeadersForHost(
      { Authorization: 'Bearer hf-token' },
      'https://huggingface.co/x/y/resolve/main/file.bin',
      'https://cdn-lfs.huggingface.co/repos/abc/file.bin?Signature=...',
    );
    expect(out).toEqual({});
  });

  it('no-op when no Authorization header is present', () => {
    expect(filterAuthHeadersForHost({}, 'https://a', 'https://b')).toEqual({});
    expect(filterAuthHeadersForHost(undefined, 'https://a', 'https://b')).toEqual({});
    expect(filterAuthHeadersForHost(
      { 'X-Custom': 'v' }, 'https://a', 'https://b',
    )).toEqual({ 'X-Custom': 'v' });
  });

  it('case-insensitive host comparison', () => {
    const out = filterAuthHeadersForHost(
      { Authorization: 'Bearer t' },
      'https://CIVITAI.com/x',
      'https://civitai.com/x',
    );
    expect(out).toEqual({ Authorization: 'Bearer t' });
  });

  it('malformed URLs strip Authorization (safe default)', () => {
    const out = filterAuthHeadersForHost(
      { Authorization: 'Bearer t' },
      'not-a-url',
      'https://civitai.com/x',
    );
    expect(out).toEqual({});
  });
});
