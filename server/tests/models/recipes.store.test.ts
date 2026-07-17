// Tests: recipe store CRUD operations.

import { describe, it, expect } from 'vitest';
import { makeFreshDbFixture } from '../lib/db/_helpers.js';
import * as store from '../../src/services/models/recipes/store.js';

const SAMPLE_LORAS = [
  { filename: 'my_lora.safetensors', save_path: 'loras', strength: 0.8 },
];

describe('store.create + store.get roundtrip', () => {
  it('preserves all fields after create', () => {
    const fix = makeFreshDbFixture();
    try {
      const created = store.create({
        title: 'Test Recipe',
        notes: 'Some notes',
        tags: ['realistic', 'portrait'],
        loras: SAMPLE_LORAS,
      });
      const fetched = store.get(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.title).toBe('Test Recipe');
      expect(fetched!.notes).toBe('Some notes');
      expect(fetched!.tags).toEqual(['realistic', 'portrait']);
      expect(fetched!.loras).toEqual(SAMPLE_LORAS);
      expect(fetched!.createdAt).toBeGreaterThan(0);
      expect(fetched!.updatedAt).toBeGreaterThan(0);
    } finally { fix.cleanup(); }
  });

  it('returns null for a missing id', () => {
    const fix = makeFreshDbFixture();
    try {
      expect(store.get(99999)).toBeNull();
    } finally { fix.cleanup(); }
  });
});

describe('store.list with search', () => {
  it('filters by case-insensitive title substring', () => {
    const fix = makeFreshDbFixture();
    try {
      store.create({ title: 'Anime Style', tags: [], loras: SAMPLE_LORAS });
      store.create({ title: 'Realistic Portrait', tags: [], loras: SAMPLE_LORAS });
      store.create({ title: 'anime upscale', tags: [], loras: SAMPLE_LORAS });

      const results = store.list({ search: 'anime' });
      expect(results).toHaveLength(2);
      const titles = results.map((r) => r.title);
      expect(titles).toContain('Anime Style');
      expect(titles).toContain('anime upscale');
    } finally { fix.cleanup(); }
  });

  it('returns all recipes when no filter is supplied', () => {
    const fix = makeFreshDbFixture();
    try {
      store.create({ title: 'A', tags: [], loras: SAMPLE_LORAS });
      store.create({ title: 'B', tags: [], loras: SAMPLE_LORAS });
      expect(store.list()).toHaveLength(2);
    } finally { fix.cleanup(); }
  });
});

describe('store.list with tag', () => {
  it('filters by tag membership', () => {
    const fix = makeFreshDbFixture();
    try {
      store.create({ title: 'R1', tags: ['anime', 'portrait'], loras: SAMPLE_LORAS });
      store.create({ title: 'R2', tags: ['realistic'], loras: SAMPLE_LORAS });
      store.create({ title: 'R3', tags: ['anime'], loras: SAMPLE_LORAS });

      const results = store.list({ tag: 'anime' });
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.title)).not.toContain('R2');
    } finally { fix.cleanup(); }
  });
});

describe('store.update', () => {
  it('patches subset of fields, preserves the rest', () => {
    const fix = makeFreshDbFixture();
    try {
      const created = store.create({
        title: 'Original',
        notes: 'Keep this',
        tags: ['tag1'],
        loras: SAMPLE_LORAS,
      });
      const updated = store.update(created.id, { title: 'Changed' });
      expect(updated).not.toBeNull();
      expect(updated!.title).toBe('Changed');
      expect(updated!.notes).toBe('Keep this');
      expect(updated!.tags).toEqual(['tag1']);
      expect(updated!.loras).toEqual(SAMPLE_LORAS);
    } finally { fix.cleanup(); }
  });

  it('returns null for missing id', () => {
    const fix = makeFreshDbFixture();
    try {
      expect(store.update(99999, { title: 'X' })).toBeNull();
    } finally { fix.cleanup(); }
  });
});

describe('store.remove', () => {
  it('returns true when recipe was deleted', () => {
    const fix = makeFreshDbFixture();
    try {
      const r = store.create({ title: 'To delete', tags: [], loras: SAMPLE_LORAS });
      expect(store.remove(r.id)).toBe(true);
      expect(store.get(r.id)).toBeNull();
    } finally { fix.cleanup(); }
  });

  it('returns false for a missing id', () => {
    const fix = makeFreshDbFixture();
    try {
      expect(store.remove(99999)).toBe(false);
    } finally { fix.cleanup(); }
  });
});
