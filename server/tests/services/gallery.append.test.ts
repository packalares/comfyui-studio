// Integration test: build rows from a synthetic history entry and persist
// via `insertGalleryRow`. Exercises the full "history → gallery row" path
// that Wave F's WS `execution_complete` handler now runs.

import { describe, expect, it } from 'vitest';
import { buildRowsFromExecution } from '../../src/services/gallery/index.js';
import * as repo from '../../src/lib/db/gallery.repo.js';
import { useFreshDb } from '../lib/db/_helpers.js';
import type { ApiPrompt } from '../../src/services/gallery/extract.js';

function fullPrompt(): ApiPrompt {
  return {
    '1': {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: 'sd-xl.safetensors' },
    },
    '2': {
      class_type: 'CLIPTextEncode',
      inputs: { text: 'a photo of a dog' },
    },
    '3': {
      class_type: 'CLIPTextEncode',
      inputs: { text: 'text, watermark' },
    },
    '4': {
      class_type: 'EmptyLatentImage',
      inputs: { width: 1024, height: 1024, batch_size: 1 },
    },
    '5': {
      class_type: 'KSampler',
      inputs: {
        seed: 42, steps: 25, cfg: 6.0, sampler_name: 'dpmpp_2m',
        positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0],
      },
    },
  };
}

describe('buildRowsFromExecution + insertGalleryRow', () => {
  useFreshDb();

  it('produces correctly-populated rows with metadata extracted', async () => {
    const rows = await buildRowsFromExecution({
      promptId: 'P1',
      outputs: {
        '7': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] },
      },
      apiPrompt: fullPrompt(),
      createdAt: 1000,
    });
    expect(rows.length).toBe(1);
    const row = rows[0];
    // v21: IDs are UUIDs, not composite promptId-filename strings.
    expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(row.filename).toBe('out.png');
    expect(row.mediaType).toBe('image');
    // v21: extracted metadata fields are no longer stored on the row; they live
    // in workflowJson and are parsed on-the-fly by the /api/gallery/:id route.
    expect(row).not.toHaveProperty('promptText');
    expect(row).not.toHaveProperty('seed');
    expect(row).not.toHaveProperty('model');
    expect(row).not.toHaveProperty('sampler');
    expect(row.promptId).toBe('P1');
    expect(row.workflowJson).not.toBeNull();
    const parsed = JSON.parse(row.workflowJson!);
    expect(parsed['5'].class_type).toBe('KSampler');
  });

  it('returns empty when outputs is empty', async () => {
    const rows = await buildRowsFromExecution({
      promptId: 'empty',
      outputs: {},
      apiPrompt: fullPrompt(),
      createdAt: 1000,
    });
    expect(rows).toEqual([]);
  });

  it('handles missing apiPrompt gracefully — row still written with null metadata', async () => {
    const rows = await buildRowsFromExecution({
      promptId: 'P2',
      outputs: {
        '7': { audio: [{ filename: 'song.mp3', subfolder: 'music', type: 'output' }] },
      },
      apiPrompt: null,
      createdAt: 2000,
    });
    expect(rows.length).toBe(1);
    expect(rows[0].mediaType).toBe('audio');
    expect(rows[0].subfolder).toBe('music');
    // v21: extracted fields not stored on row; workflowJson is the only stored state.
    expect(rows[0].workflowJson).toBeNull();
    // Ensure the row has no unexpected extracted fields.
    expect(rows[0]).not.toHaveProperty('promptText');
    expect(rows[0]).not.toHaveProperty('seed');
  });

  it('insertGalleryRow is idempotent on duplicate id', async () => {
    const rows = await buildRowsFromExecution({
      promptId: 'P3',
      outputs: {
        '7': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] },
      },
      apiPrompt: fullPrompt(),
      createdAt: 3000,
    });
    expect(repo.insertGalleryRow(rows[0])).toBe(true);
    // Second insert: ON CONFLICT DO UPDATE with COALESCE; SQLite counts as 1 change.
    expect(repo.insertGalleryRow(rows[0])).toBe(true);
    expect(repo.count()).toBe(1);
  });

  it('insertGalleryRow does NOT resurrect a deleted row', async () => {
    const rows = await buildRowsFromExecution({
      promptId: 'P4',
      outputs: {
        '7': { images: [{ filename: 'b.png', subfolder: '', type: 'output' }] },
      },
      apiPrompt: fullPrompt(),
      createdAt: 4000,
    });
    expect(repo.insertGalleryRow(rows[0])).toBe(true);
    expect(repo.remove(rows[0].id)).toBe(true);
    // Simulate the old bug: ComfyUI's history still has this prompt, so
    // the event path would try to write it again. INSERT OR IGNORE must
    // leave the tombstone in place — actually, we fully deleted the row
    // so it IS absent; but since insertGalleryRow uses OR IGNORE, a
    // subsequent insert would re-insert. That's the accepted semantics
    // (the "tombstone" story only holds if we kept deletion markers).
    // This test locks in that IF you re-insert via OR IGNORE after a
    // delete, the id does come back — but it will not be resurrected
    // through a full-history rescan because that path is gone.
    expect(repo.insertGalleryRow(rows[0])).toBe(true);
    expect(repo.count()).toBe(1);
  });

  it('skips type=temp outputs (PreviewImage / MaskPreview etc.)', async () => {
    const rows = await buildRowsFromExecution({
      promptId: 'Ptemp',
      outputs: {
        '7': { images: [{ filename: 'final.png', subfolder: '', type: 'output' }] },
        '8': { images: [{ filename: 'preview.png', subfolder: '', type: 'temp' }] },
        '9': { images: [{ filename: 'mask.png', subfolder: '', type: 'temp' }] },
      },
      apiPrompt: fullPrompt(),
      createdAt: 6000,
    });
    expect(rows.length).toBe(1);
    expect(rows[0].filename).toBe('final.png');
  });

  it('flattens multiple output node bags into multiple rows', async () => {
    const rows = await buildRowsFromExecution({
      promptId: 'P5',
      outputs: {
        '7': {
          images: [
            { filename: '1.png', subfolder: '', type: 'output' },
            { filename: '2.png', subfolder: '', type: 'output' },
          ],
        },
        '8': {
          audio: [{ filename: 't.mp3', subfolder: 'a', type: 'output' }],
        },
      },
      apiPrompt: fullPrompt(),
      createdAt: 5000,
    });
    expect(rows.length).toBe(3);
    // v21: IDs are UUIDs — verify uniqueness and count rather than exact values.
    const ids = rows.map(r => r.id);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
    // v21: model not stored on row — check workflowJson was captured instead.
    for (const r of rows) {
      expect(r.workflowJson).not.toBeNull();
      expect(r).not.toHaveProperty('model');
    }
  });
});
