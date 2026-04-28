// Tests for the GitHub release URL resolver.
//
// Coverage:
//   - parseGithubReleaseUrl accepts the canonical release-asset URL.
//   - Rejects non-release github URLs (repo root, /tree/, /blob/, etc.).
//   - Rejects malformed URLs.
//   - resolveGithubReleaseUrl probes asset size via api.github.com and
//     returns the canonical github.com URL (NOT the signed-CDN redirect).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseGithubReleaseUrl, resolveGithubReleaseUrl,
} from '../../../src/services/models/resolveGithub.js';

describe('parseGithubReleaseUrl', () => {
  it('accepts owner/repo/releases/download/tag/file', () => {
    const out = parseGithubReleaseUrl(
      'https://github.com/owner/repo/releases/download/v1.2.3/asset.bin',
    );
    expect(out).not.toBeNull();
    expect(out!.owner).toBe('owner');
    expect(out!.repo).toBe('repo');
    expect(out!.tag).toBe('v1.2.3');
    expect(out!.fileName).toBe('asset.bin');
  });

  it('preserves subpath segments and decodes the filename', () => {
    const out = parseGithubReleaseUrl(
      'https://github.com/o/r/releases/download/v1/sub/dir/file%20name.bin',
    );
    expect(out!.fileName).toBe('file name.bin');
  });

  it('rejects repo-root URLs', () => {
    expect(parseGithubReleaseUrl('https://github.com/owner/repo')).toBeNull();
  });

  it('rejects /tree/ and /blob/ URLs', () => {
    expect(parseGithubReleaseUrl('https://github.com/o/r/blob/main/README.md')).toBeNull();
    expect(parseGithubReleaseUrl('https://github.com/o/r/tree/main')).toBeNull();
  });

  it('rejects non-github hosts', () => {
    expect(parseGithubReleaseUrl('https://example.com/o/r/releases/download/v1/a.bin')).toBeNull();
  });

  it('rejects malformed URLs', () => {
    expect(parseGithubReleaseUrl('not a url')).toBeNull();
  });
});

describe('resolveGithubReleaseUrl', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('probes size via api.github.com and returns the canonical URL', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL | Request).toString();
      expect(url).toBe('https://api.github.com/repos/owner/repo/releases/tags/v1.2.3');
      return new Response(JSON.stringify({
        assets: [{ name: 'asset.bin', size: 12345 }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const out = await resolveGithubReleaseUrl(
      'https://github.com/owner/repo/releases/download/v1.2.3/asset.bin',
    );
    expect(out).not.toBeNull();
    expect(out!.fileName).toBe('asset.bin');
    expect(out!.downloadUrl).toBe(
      'https://github.com/owner/repo/releases/download/v1.2.3/asset.bin',
    );
    expect(out!.sizeBytes).toBe(12345);
  });

  it('returns the resolved entry without size when the API probe fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));
    const out = await resolveGithubReleaseUrl(
      'https://github.com/owner/repo/releases/download/v1/asset.bin',
    );
    expect(out).not.toBeNull();
    expect(out!.sizeBytes).toBeUndefined();
    expect(out!.fileName).toBe('asset.bin');
  });

  it('returns null for non-release URLs', async () => {
    const out = await resolveGithubReleaseUrl('https://github.com/owner/repo');
    expect(out).toBeNull();
  });

  // Status mapping (Wave M Gap 2): mirror HF / CivitAI semantics for the
  // size-probe API. github's tags-API is a SIDE channel — a 404 there
  // doesn't mean the actual download URL is bad, so we keep the row alive
  // (no null) and just skip the size.
  describe('size-probe status -> action mapping', () => {
    it('401 → resolved with gated + Settings prompt', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 401 }));
      const out = await resolveGithubReleaseUrl(
        'https://github.com/o/r/releases/download/v1/asset.bin',
      );
      expect(out).not.toBeNull();
      expect(out!.gated).toBe(true);
      expect(out!.gatedMessage).toMatch(/GitHub token/);
    });

    it('403 → resolved with gated', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 403 }));
      const out = await resolveGithubReleaseUrl(
        'https://github.com/o/r/releases/download/v1/asset.bin',
      );
      expect(out!.gated).toBe(true);
    });

    it('404 on the tags API → resolved without size (download URL still valid)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));
      const out = await resolveGithubReleaseUrl(
        'https://github.com/o/r/releases/download/v1/asset.bin',
      );
      // For HF / CivitAI we'd null here — but the github tags API is a
      // SIZE-only side channel. The local URL parse still gives us a
      // valid download URL; only the size is missing.
      expect(out).not.toBeNull();
      expect(out!.sizeBytes).toBeUndefined();
      expect(out!.gated).toBeUndefined();
    });

    it('503 → resolved with no size, no gated', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 503 }));
      const out = await resolveGithubReleaseUrl(
        'https://github.com/o/r/releases/download/v1/asset.bin',
      );
      expect(out).not.toBeNull();
      expect(out!.sizeBytes).toBeUndefined();
      expect(out!.gated).toBeUndefined();
    });
  });
});
