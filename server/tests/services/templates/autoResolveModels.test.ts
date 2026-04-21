// Tests for the Wave L auto-resolve pass.
//
// Covers every step in the chain — catalog hit, markdown URL match,
// HuggingFace search (exactly-one rule), CivitAI search (exactly-one
// rule), unresolved fallthrough — plus a parallel case where multiple
// filenames hit different steps in one call.
//
// The HF + CivitAI search steps are gated behind
// `STUDIO_AUTO_RESOLVE_SEARCH=1` in NODE_ENV=test so the rest of the
// staging suite doesn't hammer the real APIs. We set it per-test below.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StagedWorkflowEntry } from '../../../src/services/templates/importStaging.js';
import { autoResolveWorkflowModels } from '../../../src/services/templates/autoResolveModels.js';
import * as catalog from '../../../src/services/catalog.js';
import * as catalogStore from '../../../src/services/catalogStore.js';

function makeWf(
  models: string[], modelUrls: string[] = [],
): StagedWorkflowEntry {
  return {
    entryName: 'w.json',
    title: 'w',
    nodeCount: 1,
    models,
    modelUrls,
    plugins: [],
    mediaType: 'image',
    jsonBytes: 0,
    workflow: { nodes: [] },
  };
}

describe('autoResolveWorkflowModels', () => {
  let savedSearch: string | undefined;

  beforeEach(() => {
    savedSearch = process.env.STUDIO_AUTO_RESOLVE_SEARCH;
    process.env.STUDIO_AUTO_RESOLVE_SEARCH = '1';
    // Reset the catalog's in-memory cache so upserts from the previous
    // test (or other suites) don't turn into step-1 hits here. Steps 2-4
    // upsert on success so without this each test pollutes the next.
    catalogStore.persist({ version: 1, models: [] });
  });

  afterEach(() => {
    if (savedSearch !== undefined) process.env.STUDIO_AUTO_RESOLVE_SEARCH = savedSearch;
    else delete process.env.STUDIO_AUTO_RESOLVE_SEARCH;
    vi.restoreAllMocks();
  });

  it('step 1: catalog hit short-circuits the chain', async () => {
    catalog.upsertModel({
      filename: 'cat-hit.safetensors', name: 'cat-hit.safetensors',
      type: 'loras', save_path: 'loras',
      url: 'https://example.com/cat-hit.safetensors',
      size_bytes: 1234, source: 'test',
    });
    // Spy confirms we never hit fetch for this filename.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const wf = makeWf(['cat-hit.safetensors']);
    await autoResolveWorkflowModels(wf);
    expect(wf.autoResolvedModels?.['cat-hit.safetensors']).toMatchObject({
      source: 'catalog',
      downloadUrl: 'https://example.com/cat-hit.safetensors',
      suggestedFolder: 'loras',
      sizeBytes: 1234,
      confidence: 'high',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('step 2: markdown URL whose basename matches the filename resolves', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      // HEAD on the resolved URL.
      if (url.startsWith('https://huggingface.co/org/repo/resolve/')) {
        return new Response(null, { status: 200, headers: { 'content-length': '777' } });
      }
      return new Response(null, { status: 404 });
    });
    const wf = makeWf(
      ['unique-from-md.safetensors'],
      ['https://huggingface.co/org/repo/blob/main/unique-from-md.safetensors'],
    );
    await autoResolveWorkflowModels(wf);
    const r = wf.autoResolvedModels?.['unique-from-md.safetensors'];
    expect(r).toBeDefined();
    expect(r!.source).toBe('markdown');
    expect(r!.downloadUrl).toBe(
      'https://huggingface.co/org/repo/resolve/main/unique-from-md.safetensors',
    );
  });

  it('step 3: HuggingFace search with exactly one match resolves', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('https://huggingface.co/api/models?search=')) {
        return new Response(
          JSON.stringify([{ id: 'foo/only-one' }]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.startsWith('https://huggingface.co/api/models/foo%2Fonly-one/tree/')) {
        return new Response(
          JSON.stringify([
            { type: 'file', path: 'hf-uniq.safetensors', size: 555 },
            { type: 'file', path: 'other.txt', size: 2 },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.startsWith('https://huggingface.co/foo/only-one/resolve/')) {
        return new Response(null, { status: 200, headers: { 'content-length': '555' } });
      }
      if (url.includes('civitai.com')) {
        return new Response('{"items":[]}', { status: 200 });
      }
      return new Response(null, { status: 404 });
    });
    const wf = makeWf(['hf-uniq.safetensors']);
    await autoResolveWorkflowModels(wf);
    const r = wf.autoResolvedModels?.['hf-uniq.safetensors'];
    expect(r).toBeDefined();
    expect(r!.source).toBe('huggingface');
    expect(r!.downloadUrl).toContain('foo/only-one/resolve');
  });

  it('step 3: zero HF matches falls through', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('huggingface.co/api/models?search=')) {
        return new Response('[]', { status: 200 });
      }
      if (url.includes('civitai.com')) {
        return new Response('{"items":[]}', { status: 200 });
      }
      return new Response(null, { status: 404 });
    });
    const wf = makeWf(['missing-everywhere.safetensors']);
    await autoResolveWorkflowModels(wf);
    expect(wf.autoResolvedModels?.['missing-everywhere.safetensors']).toBeUndefined();
  });

  it('step 3: two HF matches leaves the row unresolved', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('https://huggingface.co/api/models?search=')) {
        return new Response(
          JSON.stringify([{ id: 'a/one' }, { id: 'b/two' }]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/tree/')) {
        return new Response(
          JSON.stringify([{ type: 'file', path: 'amb.safetensors', size: 1 }]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('civitai.com')) {
        return new Response('{"items":[]}', { status: 200 });
      }
      return new Response(null, { status: 404 });
    });
    const wf = makeWf(['amb.safetensors']);
    await autoResolveWorkflowModels(wf);
    expect(wf.autoResolvedModels?.['amb.safetensors']).toBeUndefined();
  });

  it('step 4: exactly one CivitAI file match resolves', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('https://huggingface.co/api/models?search=')) {
        return new Response('[]', { status: 200 });
      }
      if (url.includes('/api/v1/models?query=')) {
        return new Response(JSON.stringify({
          items: [{
            id: 42, type: 'LORA', modelVersions: [{
              id: 7, files: [{
                name: 'civ-uniq.safetensors',
                downloadUrl: 'https://civitai.com/api/download/models/7',
                sizeKB: 1024,
              }],
            }],
          }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/api/v1/models/42')) {
        // Canonical resolver path: return a model doc that doesn't contain
        // the searched filename to force the synthetic-resolution branch.
        return new Response(JSON.stringify({
          id: 42, type: 'LORA', modelVersions: [{
            id: 99, modelId: 42, files: [{
              name: 'something-else.safetensors',
              downloadUrl: 'https://civitai.com/api/download/models/99',
              primary: true,
            }],
          }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(null, { status: 404 });
    });
    const wf = makeWf(['civ-uniq.safetensors']);
    await autoResolveWorkflowModels(wf);
    const r = wf.autoResolvedModels?.['civ-uniq.safetensors'];
    expect(r).toBeDefined();
    expect(r!.source).toBe('civitai');
    expect(r!.downloadUrl).toBe('https://civitai.com/api/download/models/7');
    expect(r!.sizeBytes).toBe(1024 * 1024);
  });

  it('step 4: two CivitAI file matches leaves the row unresolved', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('https://huggingface.co/api/models?search=')) {
        return new Response('[]', { status: 200 });
      }
      if (url.includes('/api/v1/models?query=')) {
        return new Response(JSON.stringify({
          items: [{
            id: 1, modelVersions: [{
              id: 1, files: [
                { name: 'dup.safetensors', downloadUrl: 'https://x/1' },
                { name: 'dup.safetensors', downloadUrl: 'https://x/2' },
              ],
            }],
          }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(null, { status: 404 });
    });
    const wf = makeWf(['dup.safetensors']);
    await autoResolveWorkflowModels(wf);
    expect(wf.autoResolvedModels?.['dup.safetensors']).toBeUndefined();
  });

  it('fully unresolved filename falls through to no entry', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => (
      new Response(null, { status: 404 })
    ));
    const wf = makeWf(['nowhere.safetensors']);
    await autoResolveWorkflowModels(wf);
    expect(wf.autoResolvedModels?.['nowhere.safetensors']).toBeUndefined();
  });

  it('parallel chain: catalog hit + HF search run concurrently for different filenames', async () => {
    catalog.upsertModel({
      filename: 'par-cat.safetensors', name: 'par-cat.safetensors',
      type: 'checkpoints', save_path: 'checkpoints',
      url: 'https://example.com/par-cat.safetensors', source: 'test',
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('https://huggingface.co/api/models?search=')) {
        return new Response(
          JSON.stringify([{ id: 'parrot/one' }]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.startsWith('https://huggingface.co/api/models/parrot%2Fone/tree/')) {
        return new Response(
          JSON.stringify([{ type: 'file', path: 'par-hf.safetensors', size: 10 }]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.startsWith('https://huggingface.co/parrot/one/resolve/')) {
        return new Response(null, { status: 200, headers: { 'content-length': '10' } });
      }
      if (url.includes('civitai.com')) {
        return new Response('{"items":[]}', { status: 200 });
      }
      return new Response(null, { status: 404 });
    });
    const wf = makeWf(['par-cat.safetensors', 'par-hf.safetensors']);
    await autoResolveWorkflowModels(wf);
    expect(wf.autoResolvedModels?.['par-cat.safetensors']?.source).toBe('catalog');
    expect(wf.autoResolvedModels?.['par-hf.safetensors']?.source).toBe('huggingface');
  });
});
