// Tests for catalog `urlSources[]` migration + dedup-merge + sort.
//
// Coverage:
//   - detectUrlHost classifies the four host families.
//   - sortUrlSources orders by priority (hf=0, civitai=1, github=2, generic=3).
//   - mergeUrlSources dedupes by URL and preserves insertion order on ties.
//   - upsertModel synthesizes urlSources from the legacy `url` on first
//     insert and mirrors `urlSources[0].url` onto `url`.
//   - upsertModel appends + sorts when a new URL arrives for the same row.
//   - mergeIntoExisting respects the save_path-overwrite precedent.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-urlsources-'));
const CATALOG_FILE = path.join(TMP, 'catalog.json');

vi.mock('../../src/config/paths.js', async (orig) => {
  const actual = (await orig()) as { paths: Record<string, unknown> };
  return {
    paths: {
      ...actual.paths,
      catalogFile: CATALOG_FILE,
    },
  };
});

const urlSrc = await import('../../src/services/catalog.urlSources.js');
const catalog = await import('../../src/services/catalog.js');
const catalogStore = await import('../../src/services/catalogStore.js');

function reset(): void {
  try { if (fs.existsSync(CATALOG_FILE)) fs.unlinkSync(CATALOG_FILE); } catch { /* ignore */ }
  catalogStore.persist({ version: 1, models: [] });
}

describe('urlSources helpers', () => {
  it('detectUrlHost classifies hf / civitai / github / generic / null', () => {
    expect(urlSrc.detectUrlHost('https://huggingface.co/x/y/resolve/main/f.safetensors')).toBe('hf');
    expect(urlSrc.detectUrlHost('https://hf-mirror.com/x/y/resolve/main/f.safetensors')).toBe('hf');
    expect(urlSrc.detectUrlHost('https://civitai.com/api/download/models/1')).toBe('civitai');
    expect(urlSrc.detectUrlHost('https://github.com/o/r/releases/download/v1/asset.bin')).toBe('github');
    expect(urlSrc.detectUrlHost('https://example.com/file.bin')).toBe('generic');
    expect(urlSrc.detectUrlHost('not a url')).toBeNull();
    expect(urlSrc.detectUrlHost('file:///etc/passwd')).toBeNull();
  });

  it('sortUrlSources orders by host priority (hf < civitai < github < generic)', () => {
    const out = urlSrc.sortUrlSources([
      { url: 'g', host: 'generic', declaredBy: 'seed' },
      { url: 'h', host: 'hf', declaredBy: 'seed' },
      { url: 'gh', host: 'github', declaredBy: 'seed' },
      { url: 'c', host: 'civitai', declaredBy: 'seed' },
    ]);
    expect(out.map(s => s.host)).toEqual(['hf', 'civitai', 'github', 'generic']);
  });

  it('mergeUrlSources dedupes by URL and preserves earlier declaredBy', () => {
    const out = urlSrc.mergeUrlSources(
      [{ url: 'a', host: 'hf', declaredBy: 'seed' }],
      [
        { url: 'a', host: 'hf', declaredBy: 'user' },
        { url: 'b', host: 'civitai', declaredBy: 'manual' },
      ],
    );
    expect(out.map(s => s.url)).toEqual(['a', 'b']);
    const a = out.find(s => s.url === 'a');
    expect(a?.declaredBy).toBe('seed');
  });
});

describe('catalog upsertModel + urlSources migration', () => {
  beforeEach(() => { reset(); });
  afterEach(() => { reset(); });

  it('synthesizes urlSources[] on first insert from the legacy url field', () => {
    catalog.upsertModel({
      filename: 'a.safetensors',
      name: 'a',
      type: 'lora',
      save_path: 'loras',
      url: 'https://huggingface.co/x/y/resolve/main/a.safetensors',
      source: 'seed',
    });
    const row = catalog.getModel('a.safetensors');
    expect(row?.urlSources).toBeDefined();
    expect(row?.urlSources?.length).toBe(1);
    expect(row?.urlSources?.[0].host).toBe('hf');
    expect(row?.url).toBe(row?.urlSources?.[0].url);
  });

  it('appends and sorts when a higher-priority URL arrives later', () => {
    catalog.upsertModel({
      filename: 'a.safetensors',
      name: 'a',
      type: 'lora',
      save_path: 'loras',
      url: 'https://civitai.com/api/download/models/1',
      source: 'user',
    });
    catalog.upsertModel({
      filename: 'a.safetensors',
      name: 'a',
      type: 'lora',
      save_path: 'loras',
      url: 'https://huggingface.co/x/y/resolve/main/a.safetensors',
      source: 'template:foo',
    });
    const row = catalog.getModel('a.safetensors');
    expect(row?.urlSources?.map(s => s.host)).toEqual(['hf', 'civitai']);
    // Legacy `url` always reflects the priority winner (hf wins over civitai).
    expect(row?.url).toContain('huggingface.co');
  });

  it('dedup: same URL declared twice produces only one source entry', () => {
    catalog.upsertModel({
      filename: 'a.safetensors',
      name: 'a', type: 'lora', save_path: 'loras',
      url: 'https://huggingface.co/x/y/resolve/main/a.safetensors',
      source: 'seed',
    });
    catalog.upsertModel({
      filename: 'a.safetensors',
      name: 'a', type: 'lora', save_path: 'loras',
      url: 'https://huggingface.co/x/y/resolve/main/a.safetensors',
      source: 'user',
    });
    const row = catalog.getModel('a.safetensors');
    expect(row?.urlSources?.length).toBe(1);
  });

  it('legacy row missing urlSources is migrated lazily on next upsert', () => {
    // Simulate an old catalog row that was persisted before urlSources was added.
    catalogStore.persist({
      version: 1,
      models: [{
        filename: 'old.safetensors', name: 'old', type: 'lora',
        save_path: 'loras',
        url: 'https://huggingface.co/x/y/resolve/main/old.safetensors',
        size_pretty: '', size_bytes: 0, size_fetched_at: null,
        source: 'seed',
      }],
    });
    // Touch the row with another upsert (urlless update).
    catalog.upsertModel({
      filename: 'old.safetensors', name: 'old', type: 'lora',
      save_path: 'loras', url: '', source: 'user', downloading: true,
    } as Parameters<typeof catalog.upsertModel>[0]);
    const row = catalog.getModel('old.safetensors');
    expect(row?.urlSources).toBeDefined();
    expect(row?.urlSources?.length).toBeGreaterThan(0);
    expect(row?.urlSources?.[0].url).toContain('huggingface.co');
  });

  it('save_path overwrite: template+user upsert wins over existing seed save_path', () => {
    catalog.upsertModel({
      filename: 'a.safetensors',
      name: 'a', type: 'lora',
      save_path: 'checkpoints', url: 'https://example.com/a.bin',
      source: 'comfyui',
    });
    catalog.upsertModel({
      filename: 'a.safetensors',
      name: 'a', type: 'lora',
      save_path: 'loras', url: 'https://example.com/a.bin',
      source: 'template:foo',
    });
    expect(catalog.getModel('a.safetensors')?.save_path).toBe('loras');
  });
});
