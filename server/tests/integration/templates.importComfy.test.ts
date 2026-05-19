// Integration — runImportFromComfy — exercises the full pipeline:
// fetch index + per-entry workflow → atomic file write → DB upsert.
// fetch is stubbed via globalThis.fetch. paths.userTemplatesDir is
// redirected to a per-test tmpdir so nothing touches ~/.config.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ---- Redirect paths.userTemplatesDir to a tmpdir BEFORE importing the service ---

const tmpDirHolder: { dir: string } = { dir: '' };

vi.mock('../../src/config/paths.js', async (orig) => {
  const actual = (await orig()) as { paths: Record<string, unknown> };
  return {
    paths: new Proxy(actual.paths, {
      get(target, prop) {
        if (prop === 'userTemplatesDir') return tmpDirHolder.dir;
        return (target as Record<string, unknown>)[prop as string];
      },
    }),
  };
});

import { useFreshDb } from '../lib/db/_helpers.js';
import { runImportFromComfy } from '../../src/services/templates/importFromComfy.js';
import * as templateRepo from '../../src/lib/db/templates.repo.js';
import type { ImportEvent, ImportDone } from '../../src/services/templates/importFromComfy.js';

// ---- Helpers ----------------------------------------------------------------

function makeWorkflow(): Record<string, unknown> {
  return { nodes: [{ id: 1, type: 'KSampler' }, { id: 2, type: 'SaveImage' }] };
}

function makeIndex(names: string[]): Array<{ moduleName: string; category: string; icon: string; title: string; type: string; templates: Array<{ name: string; title: string; description: string; mediaType: string }> }> {
  return [
    {
      moduleName: 'test',
      category: 'image',
      icon: '',
      title: 'Image Generation',
      type: 'image',
      templates: names.map(n => ({
        name: n,
        title: n,
        description: '',
        mediaType: 'image',
      })),
    },
  ];
}

function stubFetch(
  originalFetch: typeof fetch,
  indexResponse: unknown,
  workflowResponses: Record<string, unknown>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/templates/index.json')) {
      return new Response(JSON.stringify(indexResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    // Match per-template workflow fetch.
    for (const [name, wf] of Object.entries(workflowResponses)) {
      if (url.includes(encodeURIComponent(name)) || url.includes(`/${name}.json`)) {
        return new Response(JSON.stringify(wf), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return originalFetch(input as RequestInfo, init);
  }) as typeof fetch;
}

function collectEvents(events: ImportEvent[]): ImportDone | undefined {
  return events.find((e): e is ImportDone => e.type === 'done');
}

// ---- Test suite -------------------------------------------------------------

describe('runImportFromComfy', () => {
  useFreshDb();

  let originalFetch: typeof fetch;
  let tmpDir: string;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-import-comfy-'));
    tmpDirHolder.dir = tmpDir;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('imports entries: emits ordered progress events, materialises files, upserts DB rows with source_type=1', async () => {
    const names = ['sdxl-base', 'flux-dev'];
    globalThis.fetch = stubFetch(
      originalFetch,
      makeIndex(names),
      Object.fromEntries(names.map(n => [n, makeWorkflow()])),
    );

    const events: ImportEvent[] = [];
    await runImportFromComfy('http://comfy.local', (e) => events.push(e));

    const done = collectEvents(events);
    expect(done).toBeDefined();
    expect(done!.added).toBe(2);
    expect(done!.skipped).toBe(0);
    expect(done!.errors).toBe(0);

    // Progress events emitted for each entry.
    const progress = events.filter(e => e.type === 'progress');
    expect(progress.length).toBe(2);

    // Files materialised on disk.
    expect(fs.existsSync(path.join(tmpDir, 'sdxl-base.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'flux-dev.json'))).toBe(true);

    // DB rows created with correct source_type.
    const row1 = templateRepo.getTemplate('sdxl-base');
    expect(row1).not.toBeNull();
    expect(row1!.source_type).toBe(templateRepo.SOURCE_COMFY_CATALOG);
    expect(row1!.soft_deleted).toBe(0);

    const row2 = templateRepo.getTemplate('flux-dev');
    expect(row2).not.toBeNull();
    expect(row2!.source_type).toBe(templateRepo.SOURCE_COMFY_CATALOG);
  });

  it('emits skip with reason unsafe-name for a name that sanitizes to empty', async () => {
    // A name made entirely of non-alphanumeric chars sanitizes to "".
    const unsafeName = '!@#$%^&*()';
    globalThis.fetch = stubFetch(
      originalFetch,
      makeIndex([unsafeName]),
      { [unsafeName]: makeWorkflow() },
    );

    const events: ImportEvent[] = [];
    await runImportFromComfy('http://comfy.local', (e) => events.push(e));

    const skips = events.filter(e => e.type === 'skip') as Array<{ type: 'skip'; reason: string }>;
    expect(skips.length).toBeGreaterThanOrEqual(1);
    expect(skips[0].reason).toBe('unsafe-name');

    // No file written.
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);

    const done = collectEvents(events);
    expect(done!.skipped).toBeGreaterThanOrEqual(1);
    expect(done!.added).toBe(0);
  });

  it('sanitizes path-traversal chars and imports under the cleaned name', async () => {
    // "../../../etc/passwd" → sanitizes to "etcpasswd" → safe import.
    const dangerousName = '../../../etc/passwd';
    const cleanedName = 'etcpasswd';
    globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/templates/index.json')) {
        return new Response(JSON.stringify(makeIndex([dangerousName])), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // Serve workflow for both the raw name and the cleaned name.
      if (url.includes('etcpasswd') || url.includes(encodeURIComponent(dangerousName))) {
        return new Response(JSON.stringify(makeWorkflow()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return originalFetch(input as RequestInfo, _init);
    }) as typeof fetch;

    const events: ImportEvent[] = [];
    await runImportFromComfy('http://comfy.local', (e) => events.push(e));

    const done = collectEvents(events);
    expect(done!.added).toBe(1);

    // File is under the sanitized safe name, NOT the raw dangerous one.
    expect(fs.existsSync(path.join(tmpDir, `${cleanedName}.json`))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'passwd.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '..', 'etc', 'passwd'))).toBe(false);
  });

  it('skips an entry whose DB row is already soft-deleted', async () => {
    // Pre-seed a soft-deleted row.
    templateRepo.upsertTemplate(
      {
        name: 'hidden-wf',
        displayName: 'Hidden WF',
        source_type: templateRepo.SOURCE_COMFY_CATALOG,
      },
      { models: [], plugins: [] },
    );
    templateRepo.setSoftDeleted('hidden-wf');

    globalThis.fetch = stubFetch(
      originalFetch,
      makeIndex(['hidden-wf']),
      { 'hidden-wf': makeWorkflow() },
    );

    const events: ImportEvent[] = [];
    await runImportFromComfy('http://comfy.local', (e) => events.push(e));

    const skips = events.filter(e => e.type === 'skip') as Array<{ type: 'skip'; name: string; reason: string }>;
    expect(skips.some(s => s.name === 'hidden-wf' && s.reason === 'soft-deleted')).toBe(true);

    // File must NOT be written.
    expect(fs.existsSync(path.join(tmpDir, 'hidden-wf.json'))).toBe(false);

    // Row must still be soft-deleted.
    expect(templateRepo.isSoftDeleted('hidden-wf')).toBe(true);

    const done = collectEvents(events);
    expect(done!.added).toBe(0);
    expect(done!.skipped).toBe(1);
  });

  it('preserves existing favorite=1 after re-import', async () => {
    // Pre-seed a favorited row.
    templateRepo.upsertTemplate(
      {
        name: 'fav-wf',
        displayName: 'Fav WF',
        source_type: templateRepo.SOURCE_COMFY_CATALOG,
      },
      { models: [], plugins: [] },
    );
    templateRepo.setFavorite('fav-wf', true);

    globalThis.fetch = stubFetch(
      originalFetch,
      makeIndex(['fav-wf']),
      { 'fav-wf': makeWorkflow() },
    );

    const events: ImportEvent[] = [];
    await runImportFromComfy('http://comfy.local', (e) => events.push(e));

    const done = collectEvents(events);
    expect(done!.updated).toBe(1);

    // Favorite must still be set.
    const row = templateRepo.getTemplate('fav-wf');
    expect(row).not.toBeNull();
    expect(row!.favorite).toBe(true);
  });

  it('emits error event and returns early when ComfyUI is unreachable', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;

    const events: ImportEvent[] = [];
    await runImportFromComfy('http://comfy.local', (e) => events.push(e));

    const errors = events.filter(e => e.type === 'error');
    expect(errors.length).toBe(1);
    // No done event when we bail out early.
    expect(collectEvents(events)).toBeUndefined();
  });

  it('counts fetch-failed entries in errors and emits skip', async () => {
    globalThis.fetch = stubFetch(
      originalFetch,
      makeIndex(['bad-wf']),
      {}, // no workflow response — will 404 or timeout
    );
    // Make per-entry fetch return 404.
    globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/templates/index.json')) {
        return new Response(JSON.stringify(makeIndex(['bad-wf'])), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    const events: ImportEvent[] = [];
    await runImportFromComfy('http://comfy.local', (e) => events.push(e));

    const skips = events.filter(e => e.type === 'skip') as Array<{ type: 'skip'; reason: string }>;
    expect(skips.some(s => s.reason === 'fetch-failed')).toBe(true);

    const done = collectEvents(events);
    expect(done!.errors).toBe(1);
    expect(done!.added).toBe(0);
  });
});
