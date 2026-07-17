// T1: deleting an installed model clears `installed` state on the catalog row.
//
// `markUninstalled` is the fix for audit C2: the `model:removed` event was
// calling `markInstalled` which never cleared the installed state, leaving
// the UI showing a "locally discovered, installed" badge for a deleted file.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-mark-uninstalled-'));
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

const catalogStore = await import('../../src/services/catalog/store.js');
const bus = await import('../../src/lib/events.js');
const catalogEvents = await import('../../src/services/catalog/index.js');

function reset(): void {
  try { if (fs.existsSync(CATALOG_FILE)) fs.unlinkSync(CATALOG_FILE); } catch { /* ignore */ }
  catalogStore.persist({ version: 1, models: [] });
}

function seedInstalled(filename: string): void {
  catalogStore.persist({
    version: 1,
    models: [{
      filename,
      name: filename,
      type: 'lora',
      save_path: 'loras',
      url: 'https://huggingface.co/x/y/resolve/main/' + filename,
      size_pretty: '100 MB',
      size_bytes: 100 * 1024 * 1024,
      size_fetched_at: new Date().toISOString(),
      source: 'comfyui',
    }],
  });
}

describe('markUninstalled — catalog store', () => {
  beforeEach(() => { reset(); });
  afterEach(() => { reset(); });

  it('clears size fields when a model is explicitly uninstalled', () => {
    seedInstalled('test-lora.safetensors');

    const result = catalogStore.markUninstalled('test-lora.safetensors');
    expect(result).not.toBeNull();
    expect(result!.downloading).toBe(false);
    expect(result!.error).toBeUndefined();
    // size_bytes reset to 0 so getMergedModels returns null fileStatus
    expect(result!.size_bytes).toBe(0);
    expect(result!.size_pretty).toBe('');
    expect(result!.size_fetched_at).toBeNull();
    // The catalog row itself stays (metadata + URL preserved for re-download)
    expect(result!.filename).toBe('test-lora.safetensors');
    expect(result!.url).toContain('huggingface.co');
  });

  it('returns null when the filename does not exist in the catalog', () => {
    const result = catalogStore.markUninstalled('nonexistent.safetensors');
    expect(result).toBeNull();
  });

  it('persists the cleared state so the next load() reflects it', () => {
    seedInstalled('persist-test.safetensors');
    catalogStore.markUninstalled('persist-test.safetensors');
    // Force a fresh load by nulling the in-memory cache via persist+reload pattern.
    const loaded = catalogStore.load();
    const m = loaded.models.find(r => r.filename === 'persist-test.safetensors');
    expect(m).toBeDefined();
    expect(m!.size_bytes).toBe(0);
  });
});

describe('model:removed event — catalog event handler', () => {
  beforeEach(() => {
    reset();
    bus.resetForTests();
    catalogEvents.rewireForTests();
  });
  afterEach(() => {
    reset();
    bus.resetForTests();
  });

  it('model:removed event clears size fields via markUninstalled', () => {
    seedInstalled('event-lora.safetensors');

    bus.emit('model:removed', { filename: 'event-lora.safetensors' });

    const loaded = catalogStore.load();
    const m = loaded.models.find(r => r.filename === 'event-lora.safetensors');
    expect(m).toBeDefined();
    // size cleared so getMergedModels won't report stale "installed" state
    expect(m!.size_bytes).toBe(0);
    expect(m!.downloading).toBe(false);
  });
});
