// Integration tests for the DB-first templates layer (migration v24).
//
// Exercises:
//   - filtering: source (open/api/user/favorites/all), q, category, tags, ready
//   - sorting: search_rank DESC, displayName COLLATE NOCASE ASC
//   - pagination: page + pageSize, hasMore
//   - soft-delete exclusion (default) and inclusion (softDeleted: true)
//   - q-search across displayName, description, username
//   - ready filter (yes/no/all)
//   - migration backfill: SOURCE_* constants in place

import { describe, expect, it } from 'vitest';
import * as repo from '../../src/lib/db/templates.repo.js';
import { useFreshDb } from '../lib/db/_helpers.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function row(
  name: string,
  over: Partial<repo.TemplateRow> = {},
): repo.TemplateRow {
  return {
    name,
    displayName: over.displayName ?? name,
    category: over.category ?? 'Image',
    description: over.description ?? null,
    tags_json: over.tags_json ?? JSON.stringify([]),
    installed: over.installed ?? false,
    source_type: over.source_type ?? repo.SOURCE_COMFY_CATALOG,
    soft_deleted: over.soft_deleted ?? 0,
    open_source: over.open_source ?? 1,
    search_rank: over.search_rank ?? 0,
    username: over.username ?? null,
    media_type: over.media_type ?? null,
    thumbnail_json: over.thumbnail_json ?? null,
  };
}

const DEPS: repo.TemplateDeps = { models: [], plugins: [] };

// ── tests ────────────────────────────────────────────────────────────────────

describe('templates DB-first (v24)', () => {
  useFreshDb();

  // ── source filter ──────────────────────────────────────────────────────────

  it('source=open returns only open_source=1 rows', () => {
    repo.upsertTemplate(row('open1', { open_source: 1 }), DEPS);
    repo.upsertTemplate(row('api1', { open_source: 0 }), DEPS);
    const res = repo.listPaginated({ source: 'open' }, 1, 10);
    expect(res.items.map((r) => r.name)).toEqual(['open1']);
  });

  it('source=api returns only open_source=0 rows', () => {
    repo.upsertTemplate(row('open1', { open_source: 1 }), DEPS);
    repo.upsertTemplate(row('api1', { open_source: 0 }), DEPS);
    const res = repo.listPaginated({ source: 'api' }, 1, 10);
    expect(res.items.map((r) => r.name)).toEqual(['api1']);
  });

  it('source=user returns rows with source_type IN (2,3,4)', () => {
    repo.upsertTemplate(row('comfy', { source_type: repo.SOURCE_COMFY_CATALOG }), DEPS);
    repo.upsertTemplate(row('civitai', { source_type: repo.SOURCE_CIVITAI }), DEPS);
    repo.upsertTemplate(row('github', { source_type: repo.SOURCE_GITHUB }), DEPS);
    repo.upsertTemplate(row('upload', { source_type: repo.SOURCE_UPLOAD }), DEPS);
    const res = repo.listPaginated({ source: 'user' }, 1, 10);
    const names = res.items.map((r) => r.name).sort();
    expect(names).toEqual(['civitai', 'github', 'upload']);
  });

  it('source=favorites returns only favorite=true rows', () => {
    repo.upsertTemplate(row('fav'), DEPS);
    repo.upsertTemplate(row('unfav'), DEPS);
    repo.setFavorite('fav', true);
    const res = repo.listPaginated({ source: 'favorites' }, 1, 10);
    expect(res.items.map((r) => r.name)).toEqual(['fav']);
  });

  it('source=all returns every row regardless of open_source', () => {
    repo.upsertTemplate(row('open1', { open_source: 1 }), DEPS);
    repo.upsertTemplate(row('api1', { open_source: 0 }), DEPS);
    const res = repo.listPaginated({ source: 'all' }, 1, 10);
    expect(res.total).toBe(2);
  });

  // ── soft-delete ────────────────────────────────────────────────────────────

  it('soft-deleted rows are hidden from default list', () => {
    repo.upsertTemplate(row('visible'), DEPS);
    repo.upsertTemplate(row('hidden'), DEPS);
    repo.setSoftDeleted('hidden');
    const res = repo.listPaginated({}, 1, 10);
    expect(res.items.map((r) => r.name)).toEqual(['visible']);
  });

  it('softDeleted: true includes deleted rows alongside visible rows', () => {
    repo.upsertTemplate(row('visible'), DEPS);
    repo.upsertTemplate(row('hidden'), DEPS);
    repo.setSoftDeleted('hidden');
    const res = repo.listPaginated({ softDeleted: true }, 1, 10);
    // Both rows appear — softDeleted: true removes the exclusion filter.
    const names = res.items.map((r) => r.name).sort();
    expect(names).toEqual(['hidden', 'visible']);
  });

  // ── q-search ───────────────────────────────────────────────────────────────

  it('q matches displayName (case-insensitive)', () => {
    repo.upsertTemplate(row('a', { displayName: 'Flux Schnell' }), DEPS);
    repo.upsertTemplate(row('b', { displayName: 'SDXL Base' }), DEPS);
    const res = repo.listPaginated({ q: 'flux' }, 1, 10);
    expect(res.items.map((r) => r.name)).toEqual(['a']);
  });

  it('q matches description', () => {
    repo.upsertTemplate(row('a', { description: 'fast generation pipeline' }), DEPS);
    repo.upsertTemplate(row('b', { description: 'hi-res upscale workflow' }), DEPS);
    const res = repo.listPaginated({ q: 'upscale' }, 1, 10);
    expect(res.items.map((r) => r.name)).toEqual(['b']);
  });

  it('q matches username', () => {
    repo.upsertTemplate(row('a', { username: 'alice123' }), DEPS);
    repo.upsertTemplate(row('b', { username: 'bob456' }), DEPS);
    const res = repo.listPaginated({ q: 'alice' }, 1, 10);
    expect(res.items.map((r) => r.name)).toEqual(['a']);
  });

  // ── sorting ────────────────────────────────────────────────────────────────

  it('rows sorted by search_rank DESC then displayName ASC', () => {
    repo.upsertTemplate(row('a', { displayName: 'Zebra', search_rank: 5 }), DEPS);
    repo.upsertTemplate(row('b', { displayName: 'Apple', search_rank: 5 }), DEPS);
    repo.upsertTemplate(row('c', { displayName: 'Mango', search_rank: 10 }), DEPS);
    const res = repo.listPaginated({}, 1, 10);
    expect(res.items.map((r) => r.name)).toEqual(['c', 'b', 'a']);
  });

  // ── pagination ─────────────────────────────────────────────────────────────

  it('pagination returns correct page + pageSize fields', () => {
    for (let i = 0; i < 5; i++) {
      repo.upsertTemplate(row(`tpl${i}`, { displayName: `Template ${i}` }), DEPS);
    }
    const page1 = repo.listPaginated({}, 1, 3);
    expect(page1.total).toBe(5);
    expect(page1.page).toBe(1);
    expect(page1.pageSize).toBe(3);
    expect(page1.items.length).toBe(3);
    expect(page1.hasMore).toBe(true);

    const page2 = repo.listPaginated({}, 2, 3);
    expect(page2.items.length).toBe(2);
    expect(page2.hasMore).toBe(false);
    expect(page2.page).toBe(2);
  });

  // ── ready filter ───────────────────────────────────────────────────────────

  it('ready=yes excludes uninstalled templates', () => {
    repo.upsertTemplate(row('ready', { installed: true }), DEPS);
    repo.upsertTemplate(row('notready', { installed: false }), DEPS);
    const res = repo.listPaginated({ ready: 'yes' }, 1, 10);
    expect(res.total).toBe(1);
    expect(res.items[0].name).toBe('ready');
  });

  it('ready=no excludes installed templates', () => {
    repo.upsertTemplate(row('ready', { installed: true }), DEPS);
    repo.upsertTemplate(row('notready', { installed: false }), DEPS);
    const res = repo.listPaginated({ ready: 'no' }, 1, 10);
    expect(res.total).toBe(1);
    expect(res.items[0].name).toBe('notready');
  });

  // ── new v24 columns ────────────────────────────────────────────────────────

  it('thumbnail_json, media_type, open_source, search_rank, username round-trip', () => {
    repo.upsertTemplate(row('rich', {
      thumbnail_json: JSON.stringify(['https://example.com/thumb.jpg']),
      media_type: 'video',
      open_source: 0,
      search_rank: 42,
      username: 'creator99',
    }), DEPS);
    const got = repo.getTemplate('rich');
    expect(got?.thumbnail_json).toBe('["https://example.com/thumb.jpg"]');
    expect(got?.media_type).toBe('video');
    expect(got?.open_source).toBe(0);
    expect(got?.search_rank).toBe(42);
    expect(got?.username).toBe('creator99');
  });

  // ── SOURCE_* constants ─────────────────────────────────────────────────────

  it('SOURCE constants have expected values', () => {
    expect(repo.SOURCE_UNKNOWN).toBe(0);
    expect(repo.SOURCE_COMFY_CATALOG).toBe(1);
    expect(repo.SOURCE_CIVITAI).toBe(2);
    expect(repo.SOURCE_GITHUB).toBe(3);
    expect(repo.SOURCE_UPLOAD).toBe(4);
  });
});
