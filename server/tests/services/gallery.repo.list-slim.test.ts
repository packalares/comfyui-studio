// Wave P: the list repo entrypoints (`listAll` + `listPaginated`) must not
// include the fat fields (`workflowJson`, `promptText`, `negativeText`,
// KSampler params). Those live on the detail endpoint only.
//
// `getByIdFull` is the full-row lookup backing `GET /api/gallery/:id` and
// must continue to return every captured metadata column so the detail modal
// can drive regenerate.

import { describe, expect, it } from 'vitest';
import * as repo from '../../src/lib/db/gallery.repo.js';
import { useFreshDb } from '../lib/db/_helpers.js';

function mkFatRow(id: string): repo.GalleryRow {
  // v21: extracted fields no longer stored in DB; workflowJson is the only
  // metadata column. The old promptText, seed, model etc. are derived on-the-fly
  // from workflowJson in the /api/gallery/:id route.
  return {
    id,
    filename: `${id}.png`,
    subfolder: '',
    type: 'output',
    mediaType: 'image',
    url: `/api/view?filename=${id}.png`,
    promptId: '',
    createdAt: Date.now(),
    templateName: 'tpl',
    sizeBytes: 1234,
    workflowJson: JSON.stringify({ '5': { class_type: 'KSampler', inputs: { seed: 1 } } }),
  };
}

describe('gallery repo slim vs full', () => {
  useFreshDb();

  it('listAll returns slim rows without workflowJson or KSampler metadata', () => {
    repo.insert(mkFatRow('r1'));
    repo.insert(mkFatRow('r2'));
    const rows = repo.listAll({ sort: 'newest' });
    expect(rows.length).toBe(2);
    for (const row of rows) {
      // Slim fields present.
      expect(row.id).toMatch(/^r\d$/);
      expect(row.filename).toBeTruthy();
      expect(row.mediaType).toBe('image');
      expect(row.url).toBeTruthy();
      expect(row.templateName).toBe('tpl');
      expect(row.sizeBytes).toBe(1234);
      expect(typeof row.createdAt).toBe('number');
      // Fat fields MUST be absent from the list payload so the wire bytes
      // stay small; if they appear here the SELECT column list drifted.
      expect(row).not.toHaveProperty('workflowJson');
      expect(row).not.toHaveProperty('promptText');
      expect(row).not.toHaveProperty('negativeText');
      expect(row).not.toHaveProperty('seed');
      expect(row).not.toHaveProperty('model');
      expect(row).not.toHaveProperty('sampler');
      expect(row).not.toHaveProperty('steps');
      expect(row).not.toHaveProperty('cfg');
      expect(row).not.toHaveProperty('width');
      expect(row).not.toHaveProperty('height');
    }
  });

  it('listPaginated rows also exclude fat fields', () => {
    for (let i = 0; i < 5; i++) {
      repo.insert(mkFatRow(`p${i}`));
    }
    const { items, total } = repo.listPaginated({}, 1, 3);
    expect(total).toBe(5);
    expect(items.length).toBe(3);
    for (const row of items) {
      expect(row).not.toHaveProperty('workflowJson');
      expect(row).not.toHaveProperty('promptText');
      expect(row).not.toHaveProperty('seed');
    }
  });

  it('getByIdFull returns every captured metadata column', () => {
    repo.insert(mkFatRow('full-row'));
    const row = repo.getByIdFull('full-row');
    expect(row).not.toBeNull();
    // Slim fields still present.
    expect(row?.id).toBe('full-row');
    expect(row?.templateName).toBe('tpl');
    expect(row?.sizeBytes).toBe(1234);
    // v21: workflowJson is the fat field regenerate needs; extracted columns
    // (promptText, seed, model etc.) are gone from the DB and derived on-the-fly
    // by the route. The raw repo row must NOT have them.
    expect(row?.workflowJson).toContain('KSampler');
    expect(row).not.toHaveProperty('promptText');
    expect(row).not.toHaveProperty('negativeText');
    expect(row).not.toHaveProperty('seed');
    expect(row).not.toHaveProperty('model');
    expect(row).not.toHaveProperty('sampler');
    expect(row).not.toHaveProperty('steps');
    expect(row).not.toHaveProperty('cfg');
    expect(row).not.toHaveProperty('width');
    expect(row).not.toHaveProperty('height');
  });

  it('getByIdFull returns null for unknown id', () => {
    expect(repo.getByIdFull('nope')).toBeNull();
  });
});
