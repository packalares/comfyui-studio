// Collision-rejection tests for `saveUserWorkflow` + the commit pre-flight.
//
// Coverage:
//   - saveUserWorkflow throws WorkflowNameCollisionError when the slug file
//     already exists, and the suggestedSlug points at the next free slot.
//   - A retry call with the suggested name (or a manual rename) succeeds.
//   - commitStaging surfaces the same typed error before consuming staging,
//     so the user can retry without re-uploading the zip.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  saveUserWorkflow,
} from '../../../src/services/templates/userTemplates.js';
import { WorkflowNameCollisionError } from '../../../src/services/templates/errors.js';
import { stageFromJson } from '../../../src/services/templates/importZip.js';
import { commitStaging } from '../../../src/services/templates/importCommit.js';
import * as catalog from '../../../src/services/catalog.js';
import { seedObjectInfoCache } from '../../../src/services/workflow/objectInfo.js';
import { paths } from '../../../src/config/paths.js';

// `paths.userTemplatesDir` is frozen against `os.homedir()` at module load,
// so `process.env.HOME = tmpRoot` doesn't divert saveUserWorkflow writes.
// Clear the dir on every test boundary to keep the collision check honest.
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

function tinyWorkflow(suffix: string): Record<string, unknown> {
  return {
    nodes: [
      { id: 1, type: 'UNETLoader', properties: { models: [{ name: `m-${suffix}.safetensors` }] } },
      { id: 2, type: 'SaveImage', widgets_values: [`out-${suffix}`] },
    ],
  };
}

describe('saveUserWorkflow collision', () => {
  let tmpRoot: string;
  let savedHome: string | undefined;
  let savedComfyPath: string | undefined;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'collision-test-'));
    fs.mkdirSync(path.join(tmpRoot, 'config'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'comfy'), { recursive: true });
    savedHome = process.env.HOME;
    savedComfyPath = process.env.COMFYUI_PATH;
    process.env.HOME = tmpRoot;
    process.env.COMFYUI_PATH = path.join(tmpRoot, 'comfy');
    seedObjectInfoCache({ UNETLoader: {}, SaveImage: {} });
    clearUserTemplatesDir();
  });

  afterEach(() => {
    if (savedHome !== undefined) process.env.HOME = savedHome;
    else delete process.env.HOME;
    if (savedComfyPath !== undefined) process.env.COMFYUI_PATH = savedComfyPath;
    else delete process.env.COMFYUI_PATH;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    clearUserTemplatesDir();
  });

  it('throws WorkflowNameCollisionError when the slug file already exists', () => {
    const first = saveUserWorkflow({
      name: 'Sample Workflow', title: 'Sample Workflow',
      workflow: tinyWorkflow('a'),
    });
    expect(first.name).toBe('sample-workflow');
    let caught: unknown = null;
    try {
      saveUserWorkflow({
        name: 'Sample Workflow', title: 'Sample Workflow',
        workflow: tinyWorkflow('b'),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkflowNameCollisionError);
    const collision = caught as WorkflowNameCollisionError;
    expect(collision.existingSlug).toBe('sample-workflow');
    expect(collision.suggestedSlug).toBe('sample-workflow-2');
  });

  it('succeeds on retry with the suggested slug', () => {
    saveUserWorkflow({
      name: 'Demo', title: 'Demo', workflow: tinyWorkflow('a'),
    });
    const second = saveUserWorkflow({
      name: 'demo-2', title: 'Demo 2', workflow: tinyWorkflow('b'),
    });
    expect(second.name).toBe('demo-2');
  });

  it('escalates the suggested slot past existing -2 / -3 collisions', () => {
    saveUserWorkflow({ name: 'Foo', title: 'Foo', workflow: tinyWorkflow('a') });
    saveUserWorkflow({ name: 'foo-2', title: 'Foo 2', workflow: tinyWorkflow('b') });
    saveUserWorkflow({ name: 'foo-3', title: 'Foo 3', workflow: tinyWorkflow('c') });
    let caught: unknown = null;
    try {
      saveUserWorkflow({ name: 'Foo', title: 'Foo', workflow: tinyWorkflow('d') });
    } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(WorkflowNameCollisionError);
    expect((caught as WorkflowNameCollisionError).suggestedSlug).toBe('foo-4');
  });
});

describe('commitStaging collision pre-flight', () => {
  let tmpRoot: string;
  let savedHome: string | undefined;
  let savedComfyPath: string | undefined;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-collision-'));
    fs.mkdirSync(path.join(tmpRoot, 'config'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'comfy'), { recursive: true });
    savedHome = process.env.HOME;
    savedComfyPath = process.env.COMFYUI_PATH;
    process.env.HOME = tmpRoot;
    process.env.COMFYUI_PATH = path.join(tmpRoot, 'comfy');
    seedObjectInfoCache({ UNETLoader: {}, SaveImage: {} });
    clearUserTemplatesDir();
    // Cover the auto-resolve so commit doesn't trip on missing models first.
    catalog.upsertModel({
      filename: 'm-a.safetensors', name: 'm-a.safetensors', type: 'checkpoints',
      save_path: 'checkpoints', url: 'https://example.test/m-a', source: 'test',
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

  it('throws WorkflowNameCollisionError before consuming staging on collision', async () => {
    saveUserWorkflow({
      name: 'Existing', title: 'Existing', workflow: tinyWorkflow('a'),
    });
    const staged = await stageFromJson(tinyWorkflow('a'), {
      source: 'upload', defaultTitle: 'Existing',
    });
    let caught: unknown = null;
    try {
      await commitStaging(staged.id, { workflowIndices: [0], imagesCopy: false });
    } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(WorkflowNameCollisionError);
    expect((caught as WorkflowNameCollisionError).suggestedSlug).toBe('existing-2');
    // The staging row must still be present so the retry can use it.
    const retry = await commitStaging(staged.id, {
      workflowIndices: [0], imagesCopy: false,
      titleOverrides: { 0: 'existing-2' },
    });
    expect(retry.imported).toEqual(['existing-2']);
  });
});
