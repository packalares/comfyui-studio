// Tests for the in-memory staging pipeline used by the import-redesign flow.
//
// Coverage:
//   - Zip extraction: multi-JSON, single-JSON, with/without images.
//   - Commit partial selection (write only the requested indices).
//   - TTL auto-expire + explicit abort.
//   - Path-traversal rejected (zip entry `../foo.json`).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';
import {
  stageFromZip,
  stageFromJson,
} from '../../../src/services/templates/importZip.js';
import {
  getStaging,
  abortStaging,
  toManifest,
  entryNameIsSafe,
} from '../../../src/services/templates/importStaging.js';
import { commitStaging } from '../../../src/services/templates/importCommit.js';
import * as catalog from '../../../src/services/catalog.js';
import { seedObjectInfoCache } from '../../../src/services/workflow/objectInfo.js';
import { paths } from '../../../src/config/paths.js';

// `paths.userTemplatesDir` is frozen at module load via `os.homedir()`, so
// `process.env.HOME = tmpRoot` doesn't divert saveUserWorkflow writes here.
// Wipe the dir before/after to keep the post-batch-2 collision check from
// rejecting a slug that a previous test run already wrote.
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

async function makeZip(
  entries: Record<string, string | Uint8Array>,
): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) {
    zip.file(name, content);
  }
  return zip.generateAsync({ type: 'uint8array' });
}

describe('stageFromJson', () => {
  it('accepts a minimal LiteGraph doc and derives metadata', async () => {
    const wf = tinyWorkflow('a');
    const staged = await stageFromJson(wf, { source: 'upload' });
    expect(staged.workflows).toHaveLength(1);
    const only = staged.workflows[0];
    expect(only.models).toEqual(['m-a.safetensors']);
    expect(only.mediaType).toBe('image');
    expect(only.nodeCount).toBe(2);
  });

  it('rejects a doc with no nodes array', async () => {
    await expect(
      stageFromJson({ foo: 'bar' } as Record<string, unknown>, { source: 'upload' }),
    ).rejects.toThrow(/nodes/);
  });
});

describe('stageFromZip', () => {
  it('extracts every LiteGraph JSON in a multi-workflow zip', async () => {
    const zipBuf = await makeZip({
      'a.json': JSON.stringify(tinyWorkflow('a')),
      'b.json': JSON.stringify(tinyWorkflow('b')),
      'nested/c.json': JSON.stringify(tinyWorkflow('c')),
      'readme.md': 'hello world',
      'ignore.txt': 'notes',
    });
    const staged = await stageFromZip(zipBuf, { source: 'upload' });
    expect(staged.workflows).toHaveLength(3);
    const names = staged.workflows.map((w) => w.entryName).sort();
    expect(names).toEqual(['a.json', 'b.json', 'nested/c.json']);
    expect(staged.notes).toEqual(expect.arrayContaining(['hello world', 'notes']));
  });

  it('carries reference images forward in the manifest', async () => {
    const zipBuf = await makeZip({
      'workflow.json': JSON.stringify(tinyWorkflow('a')),
      'preview.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      'thumb.webp': new Uint8Array([0x52, 0x49, 0x46, 0x46]),
    });
    const staged = await stageFromZip(zipBuf, { source: 'upload' });
    const manifest = toManifest(staged);
    expect(manifest.workflows).toHaveLength(1);
    expect(manifest.images).toHaveLength(2);
    const names = manifest.images.map((i) => i.name).sort();
    expect(names).toEqual(['preview.png', 'thumb.webp']);
  });

  it('rejects unsafe entry names via the entry-name guard', () => {
    // JSZip normalizes ".." during packing, so we test the guard directly —
    // it runs per entry inside the zip walker before we dispatch on extension.
    expect(entryNameIsSafe('../evil.json')).toBe(false);
    expect(entryNameIsSafe('/etc/passwd')).toBe(false);
    expect(entryNameIsSafe('foo/../bar.json')).toBe(false);
    expect(entryNameIsSafe('has\0nul.json')).toBe(false);
    expect(entryNameIsSafe('safe.json')).toBe(true);
    expect(entryNameIsSafe('nested/path/file.json')).toBe(true);
  });

  it('single-JSON zip still yields one staged workflow', async () => {
    const zipBuf = await makeZip({
      'only.json': JSON.stringify(tinyWorkflow('only')),
    });
    const staged = await stageFromZip(zipBuf, { source: 'upload' });
    expect(staged.workflows).toHaveLength(1);
    expect(staged.workflows[0].entryName).toBe('only.json');
  });
});

describe('commitStaging partial selection', () => {
  let tmpRoot: string;
  let savedConfig: string | undefined;
  let savedComfyPath: string | undefined;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-test-'));
    fs.mkdirSync(path.join(tmpRoot, 'config'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'comfy'), { recursive: true });
    savedConfig = process.env.STUDIO_CONFIG_FILE;
    savedComfyPath = process.env.COMFYUI_PATH;
    // Divert user-workflow writes + ComfyUI/input writes into the tmp root.
    process.env.HOME = tmpRoot;
    process.env.COMFYUI_PATH = path.join(tmpRoot, 'comfy');
    // Wave L: the commit-block validator treats zero-match plugin entries
    // as blockers. Seed object_info so ComfyUI's built-in class types
    // (UNETLoader, SaveImage) are filtered out of plugin resolution and
    // the staged workflow ends up with an empty `plugins[]`.
    seedObjectInfoCache({ UNETLoader: {}, SaveImage: {} });
    clearUserTemplatesDir();
  });

  afterEach(() => {
    if (savedConfig !== undefined) process.env.STUDIO_CONFIG_FILE = savedConfig;
    else delete process.env.STUDIO_CONFIG_FILE;
    if (savedComfyPath !== undefined) process.env.COMFYUI_PATH = savedComfyPath;
    else delete process.env.COMFYUI_PATH;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    clearUserTemplatesDir();
  });

  it('writes only the selected workflows and optionally copies images', async () => {
    const zipBuf = await makeZip({
      'a.json': JSON.stringify(tinyWorkflow('a')),
      'b.json': JSON.stringify(tinyWorkflow('b')),
      'preview.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    });
    // Wave L: pre-seed catalog for the model deps tinyWorkflow declares so
    // the auto-resolve pass covers them and the commit-block validator
    // lets this commit through.
    catalog.upsertModel({
      filename: 'm-a.safetensors', name: 'm-a.safetensors', type: 'checkpoints',
      save_path: 'checkpoints', url: 'https://example.com/m-a.safetensors', source: 'test',
    });
    catalog.upsertModel({
      filename: 'm-b.safetensors', name: 'm-b.safetensors', type: 'checkpoints',
      save_path: 'checkpoints', url: 'https://example.com/m-b.safetensors', source: 'test',
    });
    const staged = await stageFromZip(zipBuf, { source: 'upload' });
    const result = await commitStaging(staged.id, {
      workflowIndices: [0],
      imagesCopy: true,
    });
    expect(result.imported).toHaveLength(1);
    expect(result.imagesCopied).toHaveLength(1);
    // Copied image uses the <slug>__<filename> prefix policy.
    expect(result.imagesCopied[0]).toMatch(/__preview\.png$/);
    // Staging row consumed — second commit attempt must 404.
    await expect(commitStaging(staged.id, { workflowIndices: [1], imagesCopy: false }))
      .rejects.toThrow(/not found|expired/i);
  });
});

describe('TTL expire', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('drops the row after 15 minutes', async () => {
    const staged = await stageFromJson(tinyWorkflow('t'), { source: 'upload' });
    expect(getStaging(staged.id)).not.toBeNull();
    // Advance past the TTL window (15 minutes).
    vi.advanceTimersByTime(15 * 60_000 + 1);
    expect(getStaging(staged.id)).toBeNull();
  });
});

describe('abortStaging', () => {
  it('removes the row and returns true', async () => {
    const staged = await stageFromJson(tinyWorkflow('abort'), { source: 'upload' });
    expect(abortStaging(staged.id)).toBe(true);
    expect(getStaging(staged.id)).toBeNull();
  });

  it('returns false for unknown ids', () => {
    expect(abortStaging('does-not-exist')).toBe(false);
  });
});
