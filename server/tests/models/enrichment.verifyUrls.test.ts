// verifyUrlSources unit tests.
// Mocks global fetch and settings; no network calls.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/services/settings/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/settings/index.js')>();
  return { ...actual, getHfToken: () => undefined };
});

// Import after mocks.
import { verifyUrlSources } from '../../src/services/models/enrichment/verifyUrls.js';
import type { UrlSource } from '../../src/contracts/catalog.contract.js';

const LOCAL_SHA = 'aabbccdd1122334455667788990011aabbccdd1122334455667788990011aabb';

// ---- CivitAI host ----

describe('verifyUrlSources — civitai host', () => {
  it('returns ok when SHA256 matches civitaiRaw.files[].hashes.SHA256', async () => {
    const sources: UrlSource[] = [{
      url: 'https://civitai.com/api/download/models/123456',
      host: 'civitai',
      declaredBy: 'enrichment:civitai',
    }];
    const civitaiRaw = {
      files: [{ hashes: { SHA256: LOCAL_SHA.toUpperCase() } }],
    };
    const verdicts = await verifyUrlSources(sources, LOCAL_SHA, civitaiRaw);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].status).toBe('ok');
    expect(verdicts[0].sha256).toBe(LOCAL_SHA.toLowerCase());
  });

  it('returns mismatch when civitaiRaw SHA256 differs from local', async () => {
    const sources: UrlSource[] = [{
      url: 'https://civitai.com/api/download/models/999',
      host: 'civitai',
      declaredBy: 'seed',
    }];
    const civitaiRaw = {
      files: [{ hashes: { SHA256: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' } }],
    };
    const verdicts = await verifyUrlSources(sources, LOCAL_SHA, civitaiRaw);
    expect(verdicts[0].status).toBe('mismatch');
  });

  it('returns unknown when no SHA256 in civitaiRaw', async () => {
    const sources: UrlSource[] = [{
      url: 'https://civitai.com/api/download/models/999',
      host: 'civitai',
      declaredBy: 'seed',
    }];
    const verdicts = await verifyUrlSources(sources, LOCAL_SHA, { files: [] });
    expect(verdicts[0].status).toBe('unknown');
    expect(verdicts[0].sha256).toBeUndefined();
  });

  it('returns unknown when localSha256 is undefined', async () => {
    const sources: UrlSource[] = [{
      url: 'https://civitai.com/api/download/models/456',
      host: 'civitai',
      declaredBy: 'seed',
    }];
    const civitaiRaw = {
      files: [{ hashes: { SHA256: LOCAL_SHA } }],
    };
    const verdicts = await verifyUrlSources(sources, undefined, civitaiRaw);
    expect(verdicts[0].status).toBe('unknown');
  });

  it('returns unknown when civitaiRaw is null', async () => {
    const sources: UrlSource[] = [{
      url: 'https://civitai.com/api/download/models/789',
      host: 'civitai',
      declaredBy: 'seed',
    }];
    const verdicts = await verifyUrlSources(sources, LOCAL_SHA, null);
    expect(verdicts[0].status).toBe('unknown');
  });
});

// ---- HF host ----

describe('verifyUrlSources — hf host', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('returns ok when HF LFS oid matches local SHA256', async () => {
    const sources: UrlSource[] = [{
      url: `https://huggingface.co/owner/my-model/resolve/main/model.safetensors`,
      host: 'hf',
      declaredBy: 'seed',
    }];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { type: 'file', path: 'model.safetensors', lfs: { oid: LOCAL_SHA } },
      ],
    }));
    const verdicts = await verifyUrlSources(sources, LOCAL_SHA, null);
    expect(verdicts[0].status).toBe('ok');
    expect(verdicts[0].sha256).toBe(LOCAL_SHA.toLowerCase());
  });

  it('returns mismatch when HF oid differs', async () => {
    const sources: UrlSource[] = [{
      url: `https://huggingface.co/owner/repo/resolve/main/model.safetensors`,
      host: 'hf',
      declaredBy: 'seed',
    }];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { type: 'file', path: 'model.safetensors', lfs: { oid: 'cafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafe' } },
      ],
    }));
    const verdicts = await verifyUrlSources(sources, LOCAL_SHA, null);
    expect(verdicts[0].status).toBe('mismatch');
  });

  it('returns unknown when HF tree fetch fails', async () => {
    const sources: UrlSource[] = [{
      url: `https://huggingface.co/owner/repo/resolve/main/model.safetensors`,
      host: 'hf',
      declaredBy: 'seed',
    }];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 404 }));
    const verdicts = await verifyUrlSources(sources, LOCAL_SHA, null);
    expect(verdicts[0].status).toBe('unknown');
  });

  it('does NOT encode slash between owner and repo in the tree URL', async () => {
    const sources: UrlSource[] = [{
      url: `https://huggingface.co/some-owner/some-repo/resolve/main/weights.bin`,
      host: 'hf',
      declaredBy: 'seed',
    }];
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { type: 'file', path: 'weights.bin', lfs: { oid: LOCAL_SHA } },
      ],
    });
    vi.stubGlobal('fetch', fetchMock);
    await verifyUrlSources(sources, LOCAL_SHA, null);
    const calledUrl: string = fetchMock.mock.calls[0][0] as string;
    // Must contain literal /some-owner/some-repo/ — not %2F
    expect(calledUrl).toContain('/some-owner/some-repo/');
    expect(calledUrl).not.toContain('%2F');
  });
});

// ---- Generic/unknown host ----

describe('verifyUrlSources — unknown host', () => {
  it('returns unknown for generic host', async () => {
    const sources: UrlSource[] = [{
      url: 'https://example.com/model.safetensors',
      host: 'generic',
      declaredBy: 'user',
    }];
    const verdicts = await verifyUrlSources(sources, LOCAL_SHA, null);
    expect(verdicts[0].status).toBe('unknown');
    expect(verdicts[0].sha256).toBeUndefined();
  });

  it('returns unknown for github host', async () => {
    const sources: UrlSource[] = [{
      url: 'https://github.com/org/repo/releases/download/v1/model.bin',
      host: 'github',
      declaredBy: 'seed',
    }];
    const verdicts = await verifyUrlSources(sources, LOCAL_SHA, null);
    expect(verdicts[0].status).toBe('unknown');
  });
});

// ---- Multi-source ----

describe('verifyUrlSources — multiple sources', () => {
  it('returns one verdict per source', async () => {
    const sources: UrlSource[] = [
      { url: 'https://civitai.com/api/download/models/1', host: 'civitai', declaredBy: 'seed' },
      { url: 'https://example.com/model.bin', host: 'generic', declaredBy: 'user' },
    ];
    const civitaiRaw = { files: [{ hashes: { SHA256: LOCAL_SHA.toUpperCase() } }] };
    const verdicts = await verifyUrlSources(sources, LOCAL_SHA, civitaiRaw);
    expect(verdicts).toHaveLength(2);
    expect(verdicts[0].host).toBe('civitai');
    expect(verdicts[1].host).toBe('generic');
    expect(verdicts[0].status).toBe('ok');
    expect(verdicts[1].status).toBe('unknown');
  });

  it('handles empty urlSources array', async () => {
    const verdicts = await verifyUrlSources([], LOCAL_SHA, null);
    expect(verdicts).toEqual([]);
  });
});
