// Tests for the enrichment module.
//
// Tests are split across multiple focused test files to avoid top-level
// vi.mock conflicts. THIS file covers only modules that don't need mocks:
//   - sidecar read/write/roundtrip
//   - SHA256 computation

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { readSidecar, writeSidecar, sidecarExists, sidecarPath } from '../../src/services/models/enrichment/sidecar.js';
import { computeSha256 } from '../../src/services/models/enrichment/hashCompute.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'studio-enrich-'));
}

// ---- Sidecar read/write roundtrip ----

describe('sidecar', () => {
  it('roundtrip: write then read returns same meta', () => {
    const dir = tmpDir();
    const absModel = path.join(dir, 'mymodel.safetensors');
    fs.writeFileSync(absModel, '');
    const meta = {
      filename: 'mymodel.safetensors',
      save_path: 'loras',
      trigger_words: ['a', 'b'],
      favorite: true,
      tags: ['realistic'],
      nsfw_level: 0,
    };
    writeSidecar(absModel, meta);
    const read = readSidecar(absModel);
    expect(read).not.toBeNull();
    expect(read?.trigger_words).toEqual(['a', 'b']);
    expect(read?.favorite).toBe(true);
    expect(read?.tags).toEqual(['realistic']);
    expect(read?.nsfw_level).toBe(0);
  });

  it('sidecarExists returns false before write, true after', () => {
    const dir = tmpDir();
    const absModel = path.join(dir, 'x.safetensors');
    fs.writeFileSync(absModel, '');
    expect(sidecarExists(absModel)).toBe(false);
    writeSidecar(absModel, { filename: 'x.safetensors', save_path: 'loras' });
    expect(sidecarExists(absModel)).toBe(true);
  });

  it('readSidecar returns null for missing file', () => {
    const dir = tmpDir();
    const absModel = path.join(dir, 'missing.safetensors');
    expect(readSidecar(absModel)).toBeNull();
  });

  it('sidecarPath is adjacent to model with .studio.metadata.json ext', () => {
    const sp = sidecarPath('/some/dir/mymodel.safetensors');
    expect(sp).toBe('/some/dir/mymodel.studio.metadata.json');
  });

  it('writeSidecar preserves JSON structure (atomic rename → no truncation)', () => {
    const dir = tmpDir();
    const absModel = path.join(dir, 'atom.safetensors');
    fs.writeFileSync(absModel, '');
    const meta = {
      filename: 'atom.safetensors',
      save_path: 'checkpoints',
      civitai_model_id: 12345,
      last_enriched_at: '2024-01-01T00:00:00Z',
    };
    writeSidecar(absModel, meta);
    // Second write (simulate re-enrich)
    writeSidecar(absModel, { ...meta, civitai_model_id: 99999 });
    const read = readSidecar(absModel);
    expect(read?.civitai_model_id).toBe(99999);
  });

  it('user fields survive a re-write', () => {
    const dir = tmpDir();
    const absModel = path.join(dir, 'user.safetensors');
    fs.writeFileSync(absModel, '');
    writeSidecar(absModel, {
      filename: 'user.safetensors',
      save_path: 'loras',
      favorite: true,
      notes: 'my note',
    });
    // Simulate re-enrich: read → merge → write.
    const existing = readSidecar(absModel)!;
    writeSidecar(absModel, {
      ...existing,
      trigger_words: ['new-trigger'],
      // favorite and notes from existing are preserved in the merge.
    });
    const final = readSidecar(absModel);
    expect(final?.favorite).toBe(true);
    expect(final?.notes).toBe('my note');
    expect(final?.trigger_words).toEqual(['new-trigger']);
  });
});

// ---- SHA256 computation ----

describe('computeSha256', () => {
  it('matches known hash of a small file', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'fixture.bin');
    const content = 'hello sha256';
    fs.writeFileSync(file, content);
    const expected = crypto.createHash('sha256').update(content).digest('hex');
    const result = await computeSha256(file);
    expect(result).toBe(expected);
    expect(result).toHaveLength(64);
  });

  it('produces different hashes for different content', async () => {
    const dir = tmpDir();
    const a = path.join(dir, 'a.bin');
    const b = path.join(dir, 'b.bin');
    fs.writeFileSync(a, 'content-a');
    fs.writeFileSync(b, 'content-b');
    const [ha, hb] = await Promise.all([computeSha256(a), computeSha256(b)]);
    expect(ha).not.toBe(hb);
  });

  it('produces a lowercase hex string 64 chars long', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'c.bin');
    fs.writeFileSync(file, Buffer.from([0x00, 0xff, 0xde, 0xad, 0xbe, 0xef]));
    const h = await computeSha256(file);
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]+$/);
  });

  it('rejects on missing file', async () => {
    await expect(computeSha256('/nonexistent/file.bin')).rejects.toThrow();
  });
});
