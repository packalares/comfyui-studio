// Gallery repo tests — insert/delete, paginate, filter.

import { describe, expect, it } from 'vitest';
import * as repo from '../../../src/lib/db/gallery.repo.js';
import { useFreshDb } from './_helpers.js';

function mkRow(overrides: Partial<repo.GalleryRow>): repo.GalleryRow {
  // v21: the partial UNIQUE INDEX on (promptId, subfolder, filename) fires
  // when promptId is non-empty. Use promptId='' in tests that insert many rows
  // with the same filename so the index is bypassed and each id is the sole key.
  const id = overrides.id ?? 'p-f.png';
  return {
    id,
    filename: overrides.filename ?? `${id}.png`,
    subfolder: '',
    type: 'output',
    mediaType: 'image',
    url: `/api/view?filename=${overrides.filename ?? `${id}.png`}`,
    promptId: '',
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('gallery repo', () => {
  useFreshDb();

  it('insert + getById round-trips', () => {
    repo.insert(mkRow({ id: 'r1', filename: 'r1.png' }));
    const got = repo.getById('r1');
    expect(got).not.toBeNull();
    expect(got?.filename).toBe('r1.png');
    expect(got?.mediaType).toBe('image');
  });

  it('remove returns true on hit, false on miss', () => {
    repo.insert(mkRow({ id: 'r2' }));
    expect(repo.remove('r2')).toBe(true);
    expect(repo.remove('nope')).toBe(false);
    expect(repo.getById('r2')).toBeNull();
  });

  it('listPaginated sorts newest first by default', () => {
    for (let i = 0; i < 5; i++) {
      repo.insert(mkRow({ id: `r${i}`, filename: `${i}.png`, createdAt: 1000 + i }));
    }
    const { items, total } = repo.listPaginated({}, 1, 10);
    expect(total).toBe(5);
    expect(items.map(r => r.id)).toEqual(['r4', 'r3', 'r2', 'r1', 'r0']);
  });

  it('listPaginated filters by mediaType', () => {
    repo.insert(mkRow({ id: 'a', mediaType: 'image', createdAt: 10 }));
    repo.insert(mkRow({ id: 'b', mediaType: 'video', createdAt: 20 }));
    repo.insert(mkRow({ id: 'c', mediaType: 'image', createdAt: 30 }));
    const { items, total } = repo.listPaginated({ mediaType: 'image' }, 1, 10);
    expect(total).toBe(2);
    expect(items.map(r => r.id)).toEqual(['c', 'a']);
  });

  it('listPaginated paginates correctly across pages', () => {
    for (let i = 0; i < 15; i++) {
      repo.insert(mkRow({ id: `p${i}`, createdAt: i }));
    }
    const p1 = repo.listPaginated({}, 1, 5);
    const p2 = repo.listPaginated({}, 2, 5);
    const p3 = repo.listPaginated({}, 3, 5);
    expect(p1.total).toBe(15);
    expect(p1.items.length).toBe(5);
    expect(p2.items.length).toBe(5);
    expect(p3.items.length).toBe(5);
    const allIds = [...p1.items, ...p2.items, ...p3.items].map(r => r.id);
    expect(new Set(allIds).size).toBe(15);
  });

  it('insertGalleryRow inserts new rows and returns true; duplicates return false', () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      mkRow({ id: `b${i}`, filename: `b${i}.png`, createdAt: i }),
    );
    for (const row of rows) expect(repo.insertGalleryRow(row)).toBe(true);
    // Running the same batch again: every id already exists, OR IGNORE
    // no-ops, so every call returns false.
    for (const row of rows) expect(repo.insertGalleryRow(row)).toBe(false);
    expect(repo.count()).toBe(5);
  });

  it('sort=oldest reverses order', () => {
    for (let i = 0; i < 3; i++) {
      repo.insert(mkRow({ id: `s${i}`, createdAt: 100 + i }));
    }
    const asc = repo.listPaginated({ sort: 'oldest' }, 1, 10);
    expect(asc.items.map(r => r.id)).toEqual(['s0', 's1', 's2']);
  });

  describe('findNeighborIds', () => {
    it('returns null/null for unknown id', () => {
      const r = repo.findNeighborIds('no-such-id');
      expect(r).toEqual({ prevId: null, nextId: null });
    });

    it('single row has no neighbours', () => {
      repo.insert(mkRow({ id: 'only', createdAt: 1000 }));
      const r = repo.findNeighborIds('only');
      expect(r).toEqual({ prevId: null, nextId: null });
    });

    it('newest-first: middle row has correct prev and next', () => {
      // visual order newest→oldest: n2 n1 n0
      repo.insert(mkRow({ id: 'n0', createdAt: 100 }));
      repo.insert(mkRow({ id: 'n1', createdAt: 200 }));
      repo.insert(mkRow({ id: 'n2', createdAt: 300 }));
      const r = repo.findNeighborIds('n1');
      // prev = visually before = newer = n2; next = older = n0
      expect(r.prevId).toBe('n2');
      expect(r.nextId).toBe('n0');
    });

    it('oldest-first: middle row has correct prev and next', () => {
      repo.insert(mkRow({ id: 'o0', createdAt: 100 }));
      repo.insert(mkRow({ id: 'o1', createdAt: 200 }));
      repo.insert(mkRow({ id: 'o2', createdAt: 300 }));
      const r = repo.findNeighborIds('o1', { sort: 'oldest' });
      // oldest-first visual order: o0 o1 o2 → prev=o0, next=o2
      expect(r.prevId).toBe('o0');
      expect(r.nextId).toBe('o2');
    });

    it('mediaType filter excludes other types', () => {
      repo.insert(mkRow({ id: 'img1', mediaType: 'image', createdAt: 100 }));
      repo.insert(mkRow({ id: 'vid1', mediaType: 'video', createdAt: 200 }));
      repo.insert(mkRow({ id: 'img2', mediaType: 'image', createdAt: 300 }));
      // Within images only (newest-first: img2 img1), img2 has no prev, next=img1
      const r = repo.findNeighborIds('img2', { mediaType: 'image' });
      expect(r.prevId).toBeNull();
      expect(r.nextId).toBe('img1');
    });
  });
});
