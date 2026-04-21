// Wave L — commit-time validation tests.
//
// `commitStaging` must refuse to write any workflow whose selected set
// still has unresolved model or plugin dependencies. The block is
// enforced via the typed `CommitBlockedError` so the HTTP route can
// translate it into 409 Conflict.
//
// Uses `validateCommitReady` directly (pure function, no filesystem) so
// we can assert the error shape without building a full staged import.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';
import { stageFromZip } from '../../../src/services/templates/importZip.js';
import {
  commitStaging, validateCommitReady, CommitBlockedError,
} from '../../../src/services/templates/importCommit.js';
import type { StagedImport } from '../../../src/services/templates/importStaging.js';
import * as catalog from '../../../src/services/catalog.js';
import { seedObjectInfoCache } from '../../../src/services/workflow/objectInfo.js';

function stagedFixture(wfs: StagedImport['workflows']): StagedImport {
  return {
    id: 'id', createdAt: 0, source: 'upload',
    workflows: wfs, images: [], notes: [],
  };
}

describe('validateCommitReady', () => {
  it('passes when every selected workflow has all deps covered', () => {
    const staged = stagedFixture([
      {
        entryName: 'a.json', title: 'a', nodeCount: 1,
        models: ['a.safetensors'],
        modelUrls: [],
        plugins: [{ classType: 'PluginA', matches: [{ repo: 'org/plugA', title: 'Plugin A' }] }],
        mediaType: 'image', jsonBytes: 0, workflow: { nodes: [] },
        autoResolvedModels: {
          'a.safetensors': {
            source: 'catalog', downloadUrl: 'https://x/a', confidence: 'high',
          },
        },
      },
    ]);
    expect(() => validateCommitReady(staged, [0])).not.toThrow();
  });

  it('blocks when a model is unresolved', () => {
    const staged = stagedFixture([
      {
        entryName: 'a.json', title: 'a', nodeCount: 1,
        models: ['missing.safetensors'],
        modelUrls: [], plugins: [],
        mediaType: 'image', jsonBytes: 0, workflow: { nodes: [] },
      },
    ]);
    try {
      validateCommitReady(staged, [0]);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CommitBlockedError);
      const blocked = err as CommitBlockedError;
      expect(blocked.unresolvedModels).toEqual(['missing.safetensors']);
      expect(blocked.unresolvedPlugins).toEqual([]);
    }
  });

  it('blocks when a plugin has zero Manager matches', () => {
    const staged = stagedFixture([
      {
        entryName: 'a.json', title: 'a', nodeCount: 1,
        models: [], modelUrls: [],
        plugins: [{ classType: 'UnknownNode', matches: [] }],
        mediaType: 'image', jsonBytes: 0, workflow: { nodes: [] },
      },
    ]);
    try {
      validateCommitReady(staged, [0]);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CommitBlockedError);
      const blocked = err as CommitBlockedError;
      expect(blocked.unresolvedPlugins).toEqual(['UnknownNode']);
    }
  });

  it('deselected unresolved workflow does not block', () => {
    const staged = stagedFixture([
      // Selected, clean.
      {
        entryName: 'ok.json', title: 'ok', nodeCount: 1,
        models: ['ok.safetensors'], modelUrls: [], plugins: [],
        mediaType: 'image', jsonBytes: 0, workflow: { nodes: [] },
        resolvedModels: {
          'ok.safetensors': {
            downloadUrl: 'https://x/ok', source: 'huggingface',
          },
        },
      },
      // Not selected — its missing deps must not surface.
      {
        entryName: 'skip.json', title: 'skip', nodeCount: 1,
        models: ['missing.safetensors'], modelUrls: [],
        plugins: [{ classType: 'Unknown', matches: [] }],
        mediaType: 'image', jsonBytes: 0, workflow: { nodes: [] },
      },
    ]);
    expect(() => validateCommitReady(staged, [0])).not.toThrow();
  });

  it('union of resolved + autoResolved covers a filename', () => {
    const staged = stagedFixture([
      {
        entryName: 'a.json', title: 'a', nodeCount: 1,
        models: ['x.safetensors', 'y.safetensors'], modelUrls: [],
        plugins: [],
        mediaType: 'image', jsonBytes: 0, workflow: { nodes: [] },
        resolvedModels: {
          'x.safetensors': { downloadUrl: 'https://x', source: 'huggingface' },
        },
        autoResolvedModels: {
          'y.safetensors': {
            source: 'markdown', downloadUrl: 'https://y', confidence: 'high',
          },
        },
      },
    ]);
    expect(() => validateCommitReady(staged, [0])).not.toThrow();
  });
});

// Integration: the full `commitStaging` path refuses unresolved rows and
// leaves the staging row in place so the user can resolve + retry.
describe('commitStaging block integration', () => {
  let tmpRoot: string;
  let savedComfyPath: string | undefined;
  let savedConfig: string | undefined;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-block-'));
    fs.mkdirSync(path.join(tmpRoot, 'config'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'comfy'), { recursive: true });
    savedComfyPath = process.env.COMFYUI_PATH;
    savedConfig = process.env.STUDIO_CONFIG_FILE;
    process.env.HOME = tmpRoot;
    process.env.COMFYUI_PATH = path.join(tmpRoot, 'comfy');
    // Keep plugin extraction clean (no unresolved plugin noise from the
    // commit-block tests below — they only exercise the model path).
    seedObjectInfoCache({ UNETLoader: {}, SaveImage: {} });
  });

  afterEach(() => {
    if (savedComfyPath !== undefined) process.env.COMFYUI_PATH = savedComfyPath;
    else delete process.env.COMFYUI_PATH;
    if (savedConfig !== undefined) process.env.STUDIO_CONFIG_FILE = savedConfig;
    else delete process.env.STUDIO_CONFIG_FILE;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function makeZip(entries: Record<string, string>): Promise<Uint8Array> {
    const zip = new JSZip();
    for (const [n, c] of Object.entries(entries)) zip.file(n, c);
    return zip.generateAsync({ type: 'uint8array' });
  }

  it('refuses commit when staged workflow has unresolved models + preserves row', async () => {
    const wf = {
      nodes: [
        { id: 1, type: 'UNETLoader', properties: { models: [{ name: 'needed.safetensors' }] } },
        { id: 2, type: 'SaveImage', widgets_values: ['out'] },
      ],
    };
    const buf = await makeZip({ 'a.json': JSON.stringify(wf) });
    const staged = await stageFromZip(buf, { source: 'upload' });
    await expect(
      commitStaging(staged.id, { workflowIndices: [0], imagesCopy: false }),
    ).rejects.toBeInstanceOf(CommitBlockedError);
    // Staging row must still be present so the user can paste a URL + retry.
    const { getStaging } = await import('../../../src/services/templates/importStaging.js');
    expect(getStaging(staged.id)).not.toBeNull();
  });

  it('allows commit once catalog covers the required model', async () => {
    catalog.upsertModel({
      filename: 'covered.safetensors', name: 'covered.safetensors',
      type: 'checkpoints', save_path: 'checkpoints',
      url: 'https://example.com/covered.safetensors', source: 'test',
    });
    const wf = {
      nodes: [
        { id: 1, type: 'UNETLoader', properties: { models: [{ name: 'covered.safetensors' }] } },
        { id: 2, type: 'SaveImage', widgets_values: ['out'] },
      ],
    };
    const buf = await makeZip({ 'a.json': JSON.stringify(wf) });
    const staged = await stageFromZip(buf, { source: 'upload' });
    const result = await commitStaging(staged.id, { workflowIndices: [0], imagesCopy: false });
    expect(result.imported).toHaveLength(1);
  });
});
