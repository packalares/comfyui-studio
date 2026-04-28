// Unit tests for the remote-URL + paste-JSON staging helpers.
//
// Coverage:
//   * normaliseGithubUrl — blob / raw / repo-root / tree / gist / codeload.
//   * assertAllowed      — host allow-list, scheme filter, private-host guard.
//   * stageFromRemoteUrl — single JSON, zipped bundle, repo-walk (mocked fetch).
//   * stageFromPastedJson — happy path, oversized payload, invalid JSON, non
//                          LiteGraph.
//
// The network is mocked by swapping `globalThis.fetch` so the tests never
// touch api.github.com.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import {
  normaliseGithubUrl,
  assertAllowed,
} from '../../../src/services/templates/importRemote.urls.js';
import {
  stageFromRemoteUrl,
  stageFromPastedJson,
} from '../../../src/services/templates/importRemote.js';
import { IMPORT_LIMITS } from '../../../src/services/templates/importStaging.js';

function tinyWorkflow(suffix: string): Record<string, unknown> {
  return {
    nodes: [
      { id: 1, type: 'UNETLoader', properties: { models: [{ name: `m-${suffix}.safetensors` }] } },
      { id: 2, type: 'SaveImage', widgets_values: [`out-${suffix}`] },
    ],
  };
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function rawTextResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/plain', ...headers },
  });
}

describe('normaliseGithubUrl', () => {
  it('rewrites blob URLs to raw.githubusercontent.com', () => {
    const n = normaliseGithubUrl('https://github.com/alice/pack/blob/main/workflows/a.json');
    expect(n.kind).toBe('rawFile');
    expect(n.rawUrl).toBe('https://raw.githubusercontent.com/alice/pack/main/workflows/a.json');
  });

  it('rewrites /raw/ URLs to raw.githubusercontent.com', () => {
    const n = normaliseGithubUrl('https://github.com/alice/pack/raw/main/a.json');
    expect(n.kind).toBe('rawFile');
    expect(n.rawUrl).toBe('https://raw.githubusercontent.com/alice/pack/main/a.json');
  });

  it('keeps raw.githubusercontent.com URLs verbatim', () => {
    const n = normaliseGithubUrl('https://raw.githubusercontent.com/alice/pack/main/a.json');
    expect(n.kind).toBe('rawFile');
    expect(n.rawUrl).toBe('https://raw.githubusercontent.com/alice/pack/main/a.json');
  });

  it('keeps gist.githubusercontent.com URLs verbatim', () => {
    const n = normaliseGithubUrl('https://gist.githubusercontent.com/alice/abc/raw/a.json');
    expect(n.kind).toBe('rawFile');
  });

  it('marks a bare repo URL as repoWalk', () => {
    const n = normaliseGithubUrl('https://github.com/alice/pack');
    expect(n.kind).toBe('repoWalk');
    expect(n.owner).toBe('alice');
    expect(n.repo).toBe('pack');
    expect(n.ref).toBe('');
    expect(n.dir).toBe('');
  });

  it('marks /tree/<ref>/<dir> as repoWalk with dir set', () => {
    const n = normaliseGithubUrl('https://github.com/alice/pack/tree/main/workflows');
    expect(n.kind).toBe('repoWalk');
    expect(n.ref).toBe('main');
    expect(n.dir).toBe('workflows');
  });
});

describe('assertAllowed', () => {
  it('rejects non-GitHub hosts', () => {
    expect(() => assertAllowed('https://evil.example.com/foo')).toThrow(/Host not allowed/);
  });

  it('rejects invalid URLs', () => {
    expect(() => assertAllowed('not a url')).toThrow(/Invalid URL/);
  });

  it('rejects private-host URLs even when host is allow-listed-looking', () => {
    // Literal private address — `127.0.0.1` is blocked by `hostIsPrivate`.
    expect(() => assertAllowed('https://127.0.0.1/foo')).toThrow(/Host not allowed|private/);
  });

  it('rejects non-http(s) schemes', () => {
    expect(() => assertAllowed('file:///etc/passwd')).toThrow(/scheme|allowed/);
  });
});

describe('stageFromRemoteUrl (mocked fetch)', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => { globalThis.fetch = originalFetch; });

  it('stages a single-JSON raw URL', async () => {
    let hit = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (/raw\.githubusercontent\.com/.test(url)) {
        hit = true;
        return rawTextResponse(JSON.stringify(tinyWorkflow('a')), {
          'content-type': 'application/json',
        });
      }
      // Let the Manager node-map fetch fall through; `extractDepsWithPluginResolution`
      // degrades gracefully when unreachable.
      return originalFetch(input as RequestInfo, init);
    }) as typeof fetch;

    const staged = await stageFromRemoteUrl(
      'https://github.com/alice/pack/blob/main/a.json',
    );
    expect(hit).toBe(true);
    expect(staged.workflows).toHaveLength(1);
    expect(staged.workflows[0].models).toEqual(['m-a.safetensors']);
    expect(staged.sourceUrl).toMatch(/raw\.githubusercontent\.com/);
  });

  it('stages a zipped bundle (content-type hint)', async () => {
    const zip = new JSZip();
    zip.file('a.json', JSON.stringify(tinyWorkflow('a')));
    zip.file('b.json', JSON.stringify(tinyWorkflow('b')));
    const zipBytes = await zip.generateAsync({ type: 'uint8array' });

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (/raw\.githubusercontent\.com/.test(url)) {
        return new Response(zipBytes, {
          status: 200,
          headers: { 'content-type': 'application/zip' },
        });
      }
      return originalFetch(input as RequestInfo, init);
    }) as typeof fetch;

    const staged = await stageFromRemoteUrl(
      'https://raw.githubusercontent.com/alice/pack/main/bundle.zip',
    );
    expect(staged.workflows).toHaveLength(2);
  });

  it('rejects a host that is not in the allow-list', async () => {
    await expect(stageFromRemoteUrl('https://evil.example.com/a.json'))
      .rejects.toThrow(/Host not allowed/);
  });

  it('rejects a raw file that exceeds the payload cap (content-length)', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (/raw\.githubusercontent\.com/.test(url)) {
        return new Response('{}', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'content-length': String(IMPORT_LIMITS.MAX_ZIP_BYTES + 1),
          },
        });
      }
      return originalFetch(input as RequestInfo, init);
    }) as typeof fetch;

    await expect(stageFromRemoteUrl(
      'https://raw.githubusercontent.com/alice/pack/main/a.json',
    )).rejects.toThrow(/payload too large/);
  });

  it('walks a repo and stages every JSON candidate', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (!/github\.com|githubusercontent\.com/.test(url)) {
        return originalFetch(input as RequestInfo, init);
      }
      calls.push(url);
      if (url.startsWith('https://api.github.com/repos/')) {
        if (url.includes('/contents/workflows')) {
          return jsonResponse([
            {
              type: 'file', name: 'nested.json', path: 'workflows/nested.json', size: 10,
              download_url: 'https://raw.githubusercontent.com/alice/pack/HEAD/workflows/nested.json',
            },
          ]);
        }
        // Root listing.
        return jsonResponse([
          {
            type: 'file', name: 'top.json', path: 'top.json', size: 10,
            download_url: 'https://raw.githubusercontent.com/alice/pack/HEAD/top.json',
          },
          { type: 'dir', name: 'workflows', path: 'workflows' },
        ]);
      }
      if (url.endsWith('/top.json')) {
        return rawTextResponse(JSON.stringify(tinyWorkflow('top')));
      }
      if (url.endsWith('/nested.json')) {
        return rawTextResponse(JSON.stringify(tinyWorkflow('nested')));
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const staged = await stageFromRemoteUrl('https://github.com/alice/pack');
    expect(staged.workflows).toHaveLength(2);
    const names = staged.workflows.map((w) => w.entryName).sort();
    expect(names).toEqual(['top.json', 'workflows/nested.json']);
    // The walker should have hit the listings + both downloads.
    expect(calls.some((u) => u.includes('/contents'))).toBe(true);
  });
});

describe('stageFromPastedJson', () => {
  let savedFetch: typeof fetch;
  beforeEach(() => { savedFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = savedFetch; });

  it('stages valid LiteGraph JSON', async () => {
    const staged = await stageFromPastedJson(JSON.stringify(tinyWorkflow('p')));
    expect(staged.workflows).toHaveLength(1);
    expect(staged.workflows[0].entryName).toBe('pasted-workflow.json');
  });

  it('applies the optional title override', async () => {
    const staged = await stageFromPastedJson(
      JSON.stringify(tinyWorkflow('p')),
      { title: 'My Pasted Flow' },
    );
    expect(staged.workflows[0].title).toBe('My Pasted Flow');
  });

  it('rejects invalid JSON', async () => {
    await expect(stageFromPastedJson('{not valid')).rejects.toThrow(/not valid JSON/i);
  });

  it('rejects non-LiteGraph docs', async () => {
    // Paste path now also accepts TemplateData wrappers, so the error
    // message changed; the wrapper detector is the chokepoint.
    await expect(stageFromPastedJson(JSON.stringify({ foo: 'bar' })))
      .rejects.toThrow(/LiteGraph workflow or TemplateData wrapper/);
  });

  it('rejects payloads over the 20 MB cap', async () => {
    // 21 MB of filler chars — cheaper than constructing a real LiteGraph of
    // that size because the guard fires before the JSON parser runs.
    const big = 'x'.repeat(IMPORT_LIMITS.MAX_ZIP_BYTES + 1);
    await expect(stageFromPastedJson(big)).rejects.toThrow(/payload too large/);
  });
});
