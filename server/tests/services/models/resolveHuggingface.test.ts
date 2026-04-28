// Tests for the HuggingFace URL resolver used by the Wave E import review
// step "Resolve via URL" affordance.
//
// Coverage:
//   - Accepts /blob/ URLs (normalised to /resolve/).
//   - Accepts /resolve/ URLs (passed through).
//   - Repo-root URLs return null (ambiguous, cannot pick a file).
//   - Non-HF hosts return null.
//   - HEAD failure still yields a valid result without sizeBytes.
//   - Folder guess uses path segment + extension heuristic.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveHuggingfaceUrl } from '../../../src/services/models/resolveHuggingface.js';

function mockHead(sizeBytes: number | null): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    expect(init?.method).toBe('HEAD');
    if (sizeBytes === null) {
      return new Response(null, { status: 404 });
    }
    return new Response(null, {
      status: 200,
      headers: { 'content-length': String(sizeBytes) },
    });
  });
}

describe('resolveHuggingfaceUrl', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalises /blob/ URLs to /resolve/ and HEADs for size', async () => {
    mockHead(1024 * 1024);
    const out = await resolveHuggingfaceUrl(
      'https://huggingface.co/org/repo/blob/main/checkpoint.safetensors',
    );
    expect(out).not.toBeNull();
    expect(out!.source).toBe('huggingface');
    expect(out!.downloadUrl).toBe(
      'https://huggingface.co/org/repo/resolve/main/checkpoint.safetensors',
    );
    expect(out!.fileName).toBe('checkpoint.safetensors');
    expect(out!.repoId).toBe('org/repo');
    expect(out!.revision).toBe('main');
    expect(out!.sizeBytes).toBe(1024 * 1024);
    expect(out!.suggestedFolder).toBe('checkpoints');
  });

  it('accepts /resolve/ URLs unchanged', async () => {
    mockHead(42);
    const out = await resolveHuggingfaceUrl(
      'https://huggingface.co/a/b/resolve/abc123/nested/path/model.safetensors',
    );
    expect(out).not.toBeNull();
    expect(out!.downloadUrl).toBe(
      'https://huggingface.co/a/b/resolve/abc123/nested/path/model.safetensors',
    );
    expect(out!.revision).toBe('abc123');
    expect(out!.fileName).toBe('model.safetensors');
    expect(out!.sizeBytes).toBe(42);
  });

  it('returns null for a repo-root URL (no file part)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('should not be called'));
    const out = await resolveHuggingfaceUrl('https://huggingface.co/org/repo');
    expect(out).toBeNull();
  });

  it('returns null for a non-HF host', async () => {
    const out = await resolveHuggingfaceUrl(
      'https://example.com/org/repo/blob/main/model.safetensors',
    );
    expect(out).toBeNull();
  });

  it('returns null for a malformed URL', async () => {
    const out = await resolveHuggingfaceUrl('not a url');
    expect(out).toBeNull();
  });

  it('still resolves when HEAD fails — sizeBytes omitted', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNRESET'));
    const out = await resolveHuggingfaceUrl(
      'https://huggingface.co/x/y/blob/main/thing.safetensors',
    );
    expect(out).not.toBeNull();
    expect(out!.sizeBytes).toBeUndefined();
    expect(out!.fileName).toBe('thing.safetensors');
  });

  it('guesses the loras folder from a /loras/ path segment', async () => {
    mockHead(100);
    const out = await resolveHuggingfaceUrl(
      'https://huggingface.co/u/r/resolve/main/loras/my-lora.safetensors',
    );
    expect(out!.suggestedFolder).toBe('loras');
  });

  it('guesses loras from a filename hint when path lacks the segment', async () => {
    mockHead(100);
    const out = await resolveHuggingfaceUrl(
      'https://huggingface.co/u/r/resolve/main/anime_lora.safetensors',
    );
    expect(out!.suggestedFolder).toBe('loras');
  });

  it('guesses vae folder from a /vae/ path segment', async () => {
    mockHead(100);
    const out = await resolveHuggingfaceUrl(
      'https://huggingface.co/u/r/resolve/main/vae/foo.safetensors',
    );
    expect(out!.suggestedFolder).toBe('vae');
  });

  it('accepts /datasets/<org>/<repo>/blob/<ref>/<path> URLs', async () => {
    mockHead(2048);
    const out = await resolveHuggingfaceUrl(
      'https://huggingface.co/datasets/org/repo/blob/main/data/file.bin',
    );
    expect(out).not.toBeNull();
    expect(out!.repoId).toBe('org/repo');
    expect(out!.revision).toBe('main');
    expect(out!.fileName).toBe('file.bin');
    expect(out!.downloadUrl).toBe(
      'https://huggingface.co/datasets/org/repo/resolve/main/data/file.bin',
    );
  });

  it('accepts /datasets/.../resolve/... URLs unchanged', async () => {
    mockHead(2048);
    const out = await resolveHuggingfaceUrl(
      'https://huggingface.co/datasets/org/repo/resolve/abc123/sub/file.bin',
    );
    expect(out!.downloadUrl).toBe(
      'https://huggingface.co/datasets/org/repo/resolve/abc123/sub/file.bin',
    );
    expect(out!.revision).toBe('abc123');
  });

  it('rejects /spaces/... URLs', async () => {
    const out = await resolveHuggingfaceUrl(
      'https://huggingface.co/spaces/org/space/blob/main/app.py',
    );
    expect(out).toBeNull();
  });
});
