// Round-trip integration: a wrapper JSON flows through extractLitegraph →
// stageFromJson → commit (saveUserWorkflow) → re-read. Defaults must persist.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { extractLitegraph } from '../../../src/services/templates/extractLitegraph.js';
import { stageFromJson } from '../../../src/services/templates/importZip.js';
import { commitStaging } from '../../../src/services/templates/importCommit.js';
import {
  listUserWorkflows,
} from '../../../src/services/templates/userTemplates.js';
import * as catalog from '../../../src/services/catalog.js';
import { seedObjectInfoCache } from '../../../src/services/workflow/objectInfo.js';
import { paths } from '../../../src/config/paths.js';

// Same `paths.userTemplatesDir` caveat as the other commit-path tests —
// `os.homedir()` is frozen at module load, so we wipe the dir manually.
function clearUserTemplatesDir(): void {
  try {
    if (!fs.existsSync(paths.userTemplatesDir)) return;
    for (const f of fs.readdirSync(paths.userTemplatesDir)) {
      if (f.endsWith('.json')) {
        try { fs.rmSync(path.join(paths.userTemplatesDir, f), { force: true }); }
        catch { /* best effort */ }
      }
    }
  } catch { /* best effort */ }
}

function tinyWorkflow(): Record<string, unknown> {
  return {
    nodes: [
      { id: 1, type: 'UNETLoader', properties: { models: [{ name: 'm.safetensors' }] } },
      { id: 2, type: 'SaveImage', widgets_values: ['out'] },
    ],
  };
}

describe('wrapper round-trip', () => {
  let tmpRoot: string;
  let savedHome: string | undefined;
  let savedComfyPath: string | undefined;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wrapper-rt-'));
    fs.mkdirSync(path.join(tmpRoot, 'config'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'comfy'), { recursive: true });
    savedHome = process.env.HOME;
    savedComfyPath = process.env.COMFYUI_PATH;
    process.env.HOME = tmpRoot;
    process.env.COMFYUI_PATH = path.join(tmpRoot, 'comfy');
    seedObjectInfoCache({ UNETLoader: {}, SaveImage: {} });
    clearUserTemplatesDir();
    catalog.upsertModel({
      filename: 'm.safetensors', name: 'm.safetensors', type: 'checkpoints',
      save_path: 'checkpoints', url: 'https://example.test/m', source: 'test',
    });
  });

  afterEach(() => {
    if (savedHome !== undefined) process.env.HOME = savedHome;
    else delete process.env.HOME;
    if (savedComfyPath !== undefined) process.env.COMFYUI_PATH = savedComfyPath;
    else delete process.env.COMFYUI_PATH;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    clearUserTemplatesDir();
  });

  it('preserves wrapper title / description / tags / thumbnail through commit', async () => {
    const wrapped = {
      name: 'studio-wrap-test',
      title: 'Wrapped Title',
      description: 'Wrapped description body.',
      tags: ['Tag-A', 'Tag-B'],
      thumbnail: ['https://example.test/thumb.png'],
      workflow: tinyWorkflow(),
    };
    const extracted = extractLitegraph(wrapped);
    expect(extracted).not.toBeNull();
    const staged = await stageFromJson(extracted!.workflow, {
      source: 'upload',
      ...extracted!.defaults,
    });
    expect(staged.defaultTitle).toBe('Wrapped Title');
    expect(staged.defaultDescription).toBe('Wrapped description body.');
    expect(staged.defaultTags).toEqual(['Tag-A', 'Tag-B']);
    expect(staged.defaultThumbnail).toBe('https://example.test/thumb.png');

    const result = await commitStaging(staged.id, { workflowIndices: [0], imagesCopy: false });
    expect(result.imported).toHaveLength(1);
    const list = listUserWorkflows();
    const saved = list.find((t) => t.name === 'wrapped-title');
    expect(saved).toBeDefined();
    expect(saved!.title).toBe('Wrapped Title');
    expect(saved!.description).toBe('Wrapped description body.');
    expect(saved!.tags).toEqual(['Tag-A', 'Tag-B']);
    expect(saved!.thumbnail).toEqual(['https://example.test/thumb.png']);
  });
});
