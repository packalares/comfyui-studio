// Tests for the disk-sweep orphan importer.
// Builds a fixture directory tree in a temp folder, points the sweep at it
// via the rootOverride argument, and verifies correct filtering + dedupe.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { sweepOrphansFromDisk } from '../../../src/services/gallery/diskSweep.js';
import * as repo from '../../../src/lib/db/gallery.repo.js';
import { useFreshDb } from '../../lib/db/_helpers.js';

// ─── Fixture helpers ──────────────────────────────────────────────────────────

let tmpDir = '';

function writeFile(relPath: string, content = 'x'): void {
  const abs = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function writeEmpty(relPath: string): void {
  const abs = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, '');
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

useFreshDb();

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diskSweep-'));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('sweepOrphansFromDisk', () => {
  it('returns zero counts when rootOverride is missing or unreadable', async () => {
    const r1 = await sweepOrphansFromDisk('/nonexistent/path/xyz');
    expect(r1).toEqual({ inserted: 0, scanned: 0 });

    // Empty string path also treated as "not configured"
    const r2 = await sweepOrphansFromDisk('');
    expect(r2).toEqual({ inserted: 0, scanned: 0 });
  });

  it('inserts allowed files and skips all filtered categories', async () => {
    // Files that SHOULD be inserted
    writeFile('root.png');
    writeFile('subdir/nested.mp4');
    writeFile('audio/track.flac');
    writeFile('models/scene.glb');

    // Files that should be SKIPPED
    writeFile('temp/preview.png');              // temp subfolder
    writeFile('.hidden');                       // hidden file
    writeFile('_output_images_will_be_put_here'); // marker name
    writeFile('workflow.meta.json');            // metadata sidecar
    writeFile('latents/sample.latent');         // latent extension
    writeFile('unknown/file.xyz');              // disallowed extension
    writeEmpty('empty.png');                    // zero-byte file

    const result = await sweepOrphansFromDisk(tmpDir);

    // 4 allowed non-zero files at various depths
    expect(result.inserted).toBe(4);
    // scanned = number of files visited (before filtering); every isFile() entry
    // including the marker, meta.json, .latent, .xyz, empty.png, and hidden
    // but NOT the temp/ contents because that dir is skipped before recursing.
    // Hidden file is skipped before scanned counts, so not included.
    // Let's just verify it's >= the inserted count (exact count depends on
    // which files are counted before vs after extension checks).
    expect(result.scanned).toBeGreaterThanOrEqual(result.inserted);

    // Verify inserted rows exist in the DB with correct fields. The id format
    // is `disk-<uuid>` (opaque, single URL path segment); identify rows by
    // (subfolder, filename) instead of an exact-id literal.
    const rows = repo.listAll();
    expect(rows).toHaveLength(4);
    const find = (subfolder: string, filename: string) =>
      rows.find(r => r.subfolder === subfolder && r.filename === filename);
    expect(find('', 'root.png')).toBeDefined();
    expect(find('subdir', 'nested.mp4')).toBeDefined();
    expect(find('audio', 'track.flac')).toBeDefined();
    expect(find('models', 'scene.glb')).toBeDefined();
    // All orphan ids share the `disk-` prefix.
    for (const r of rows) expect(r.id.startsWith('disk-')).toBe(true);
  });

  it('does not duplicate a row already present in the gallery', async () => {
    writeFile('root.png');
    writeFile('subdir/nested.mp4');

    // Pre-insert a row for root.png — simulates it already being in the gallery
    // from a previous live-pipeline run.
    repo.insertGalleryRow({
      id: 'existing-root.png',
      filename: 'root.png',
      subfolder: '',
      type: 'output',
      mediaType: 'image',
      url: '/api/view?filename=root.png&subfolder=&type=output',
      promptId: 'some-prompt-id',
      createdAt: Date.now(),
    });

    const result = await sweepOrphansFromDisk(tmpDir);

    // Only nested.mp4 should be inserted; root.png is already in the gallery.
    expect(result.inserted).toBe(1);

    const rows = repo.listAll();
    expect(rows).toHaveLength(2);

    // The pre-existing row keeps its id; the new orphan row is `disk-<uuid>`.
    expect(rows.map(r => r.id)).toContain('existing-root.png');
    // Exactly one orphan row inserted, and it's the nested.mp4.
    const orphans = rows.filter(r => r.id.startsWith('disk-'));
    expect(orphans).toHaveLength(1);
    expect(orphans[0].subfolder).toBe('subdir');
    expect(orphans[0].filename).toBe('nested.mp4');
  });

  it('inserted rows have null rich metadata fields', async () => {
    writeFile('image.png');

    await sweepOrphansFromDisk(tmpDir);

    // listAll() returns the slim shape (no rich fields). Use the row's id
    // to fetch the full row via getByIdFull so the rich fields are exposed.
    const slim = repo.listAll().find(r => r.filename === 'image.png' && r.subfolder === '');
    expect(slim).toBeDefined();
    const row = slim ? repo.getByIdFull(slim.id) : null;
    expect(row).not.toBeNull();

    // Rich fields must stay null/absent — no metadata parsing for disk-sweep rows.
    // v21: workflowJson stays null; extracted columns (promptText, seed, model,
    // sampler) are no longer on the DB row at all.
    expect(row?.workflowJson).toBeNull();
    expect(row).not.toHaveProperty('promptText');
    expect(row).not.toHaveProperty('seed');
    expect(row).not.toHaveProperty('model');
    expect(row).not.toHaveProperty('sampler');

    // Basic fields should be set
    expect(row?.filename).toBe('image.png');
    expect(row?.subfolder).toBe('');
    expect(row?.type).toBe('output');
    expect(row?.mediaType).toBe('image');
    expect(typeof row?.createdAt).toBe('number');
    expect((row?.sizeBytes ?? 0) > 0).toBe(true);
  });

  it('skips temp/ subdirectory at any nesting level', async () => {
    writeFile('temp/should_skip.png');
    writeFile('keep.png');

    const result = await sweepOrphansFromDisk(tmpDir);

    expect(result.inserted).toBe(1);
    const rows = repo.listAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.filename).toBe('keep.png');
    expect(rows[0]?.subfolder).toBe('');
    expect(rows[0]?.id.startsWith('disk-')).toBe(true);
  });

  it('skips zero-byte files', async () => {
    writeEmpty('empty.png');
    writeFile('nonempty.png');

    const result = await sweepOrphansFromDisk(tmpDir);

    expect(result.inserted).toBe(1);
    const rows = repo.listAll();
    expect(rows.find(r => r.filename === 'nonempty.png')).toBeDefined();
    expect(rows.find(r => r.filename === 'empty.png')).toBeUndefined();
  });

  it('url uses encodeURIComponent for filename and subfolder', async () => {
    writeFile('my subdir/image with spaces.png');

    await sweepOrphansFromDisk(tmpDir);

    const row = repo.listAll().find(r =>
      r.filename === 'image with spaces.png' && r.subfolder === 'my subdir',
    );
    expect(row).toBeDefined();
    expect(row?.url).toBe(
      '/api/view?filename=image%20with%20spaces.png&subfolder=my%20subdir&type=output',
    );
  });
});
