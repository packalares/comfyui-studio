// Templates repo tests — upsert, list filters (q/category/ready/all combos),
// findTemplatesRequiringModel / findTemplatesRequiringPlugin, rebuildAll.

import { describe, expect, it } from 'vitest';
import * as repo from '../../../src/lib/db/templates.repo.js';
import { useFreshDb } from './_helpers.js';

function mk(
  name: string,
  over: Partial<repo.TemplateRow> = {},
  deps: repo.TemplateDeps = { models: [], plugins: [] },
): { row: repo.TemplateRow; deps: repo.TemplateDeps } {
  return {
    row: {
      name,
      displayName: over.displayName ?? name,
      category: over.category ?? 'Image',
      description: over.description ?? `desc ${name}`,
      source: over.source ?? 'open',
      workflow_json: over.workflow_json ?? null,
      tags_json: over.tags_json ?? JSON.stringify([]),
      installed: over.installed ?? false,
    },
    deps,
  };
}

describe('templates repo', () => {
  useFreshDb();

  it('upsertTemplate inserts a row and hydrates deps', () => {
    const { row, deps } = mk('wf.one', { displayName: 'Alpha' }, {
      models: ['sd.safetensors'], plugins: ['some/pack'],
    });
    repo.upsertTemplate(row, deps);
    const got = repo.getTemplate('wf.one');
    expect(got).not.toBeNull();
    expect(got?.displayName).toBe('Alpha');
    expect(got?.models).toEqual(['sd.safetensors']);
    expect(got?.plugins).toEqual(['some/pack']);
  });

  it('upsertTemplate replaces deps cleanly on subsequent upsert', () => {
    const a = mk('wf.one', {}, { models: ['a.safetensors'], plugins: ['p1'] });
    repo.upsertTemplate(a.row, a.deps);
    const b = mk('wf.one', {}, { models: ['b.safetensors'], plugins: [] });
    repo.upsertTemplate(b.row, b.deps);
    const got = repo.getTemplate('wf.one');
    expect(got?.models).toEqual(['b.safetensors']);
    expect(got?.plugins).toEqual([]);
  });

  it('setInstalledForTemplates flips the cached ready flag', () => {
    const a = mk('wf.one');
    const b = mk('wf.two');
    repo.upsertTemplate(a.row, a.deps);
    repo.upsertTemplate(b.row, b.deps);
    expect(repo.getTemplate('wf.one')?.installed).toBe(false);
    repo.setInstalledForTemplates(['wf.one'], true);
    expect(repo.getTemplate('wf.one')?.installed).toBe(true);
    expect(repo.getTemplate('wf.two')?.installed).toBe(false);
    repo.setInstalledForTemplates(['wf.one', 'wf.two'], true);
    expect(repo.getTemplate('wf.two')?.installed).toBe(true);
  });

  it('findTemplatesRequiringModel returns every template with that filename', () => {
    repo.upsertTemplate(mk('a').row, { models: ['x.safetensors'], plugins: [] });
    repo.upsertTemplate(mk('b').row, { models: ['x.safetensors', 'y.safetensors'], plugins: [] });
    repo.upsertTemplate(mk('c').row, { models: ['y.safetensors'], plugins: [] });
    expect(repo.findTemplatesRequiringModel('x.safetensors').sort()).toEqual(['a', 'b']);
    expect(repo.findTemplatesRequiringModel('y.safetensors').sort()).toEqual(['b', 'c']);
    expect(repo.findTemplatesRequiringModel('z.safetensors')).toEqual([]);
  });

  it('findTemplatesRequiringPlugin returns every template referencing that id', () => {
    repo.upsertTemplate(mk('a').row, { models: [], plugins: ['plug-a'] });
    repo.upsertTemplate(mk('b').row, { models: [], plugins: ['plug-a', 'plug-b'] });
    expect(repo.findTemplatesRequiringPlugin('plug-a').sort()).toEqual(['a', 'b']);
    expect(repo.findTemplatesRequiringPlugin('plug-b')).toEqual(['b']);
    expect(repo.findTemplatesRequiringPlugin('plug-c')).toEqual([]);
  });

  it('listPaginated filters by q substring', () => {
    repo.upsertTemplate(mk('cat.one', { displayName: 'Cat Whiskers' }).row, { models: [], plugins: [] });
    repo.upsertTemplate(mk('dog.one', { displayName: 'Dog Walker' }).row, { models: [], plugins: [] });
    const byTitle = repo.listPaginated({ q: 'whisk' }, 1, 10);
    expect(byTitle.total).toBe(1);
    expect(byTitle.items[0].name).toBe('cat.one');
    const byName = repo.listPaginated({ q: 'dog' }, 1, 10);
    expect(byName.total).toBe(1);
  });

  it('listPaginated filters by category', () => {
    repo.upsertTemplate(mk('i1', { category: 'Image' }).row, { models: [], plugins: [] });
    repo.upsertTemplate(mk('i2', { category: 'Image' }).row, { models: [], plugins: [] });
    repo.upsertTemplate(mk('v1', { category: 'Video' }).row, { models: [], plugins: [] });
    const img = repo.listPaginated({ category: 'Image' }, 1, 10);
    expect(img.total).toBe(2);
    const vid = repo.listPaginated({ category: 'Video' }, 1, 10);
    expect(vid.total).toBe(1);
    const all = repo.listPaginated({ category: 'All' }, 1, 10);
    expect(all.total).toBe(3);
  });

  it('listPaginated filters by ready=yes|no|all', () => {
    repo.upsertTemplate(mk('r1', { installed: true }).row, { models: [], plugins: [] });
    repo.upsertTemplate(mk('r2', { installed: false }).row, { models: [], plugins: [] });
    repo.upsertTemplate(mk('r3', { installed: false }).row, { models: [], plugins: [] });
    const yes = repo.listPaginated({ ready: 'yes' }, 1, 10);
    expect(yes.total).toBe(1);
    expect(yes.items[0].name).toBe('r1');
    const no = repo.listPaginated({ ready: 'no' }, 1, 10);
    expect(no.total).toBe(2);
    const all = repo.listPaginated({ ready: 'all' }, 1, 10);
    expect(all.total).toBe(3);
  });

  it('listPaginated filters by tags (OR match)', () => {
    repo.upsertTemplate(mk('a', { tags_json: JSON.stringify(['fast', 'image']) }).row, { models: [], plugins: [] });
    repo.upsertTemplate(mk('b', { tags_json: JSON.stringify(['slow', 'video']) }).row, { models: [], plugins: [] });
    repo.upsertTemplate(mk('c', { tags_json: JSON.stringify(['image']) }).row, { models: [], plugins: [] });
    const res = repo.listPaginated({ tags: ['image'] }, 1, 10);
    expect(res.items.map((r) => r.name).sort()).toEqual(['a', 'c']);
  });

  it('listPaginated combines multiple filters with AND', () => {
    repo.upsertTemplate(mk('a', { category: 'Image', installed: true }).row, { models: [], plugins: [] });
    repo.upsertTemplate(mk('b', { category: 'Image', installed: false }).row, { models: [], plugins: [] });
    repo.upsertTemplate(mk('c', { category: 'Video', installed: true }).row, { models: [], plugins: [] });
    const res = repo.listPaginated({ category: 'Image', ready: 'yes' }, 1, 10);
    expect(res.total).toBe(1);
    expect(res.items[0].name).toBe('a');
  });

  it('rebuildAll wipes + reinserts atomically', () => {
    repo.upsertTemplate(mk('old1').row, { models: ['old.pth'], plugins: [] });
    repo.upsertTemplate(mk('old2').row, { models: [], plugins: ['old-plug'] });
    const n = repo.rebuildAll([
      { template: mk('new1').row, deps: { models: ['new.pth'], plugins: [] } },
      { template: mk('new2').row, deps: { models: [], plugins: ['new-plug'] } },
    ]);
    expect(n).toBe(2);
    expect(repo.count()).toBe(2);
    expect(repo.getTemplate('old1')).toBeNull();
    expect(repo.findTemplatesRequiringPlugin('old-plug')).toEqual([]);
    expect(repo.findTemplatesRequiringModel('new.pth')).toEqual(['new1']);
  });

  it('deleteTemplate cascades dep edges', () => {
    repo.upsertTemplate(mk('a').row, { models: ['fn.pth'], plugins: ['p1'] });
    repo.deleteTemplate('a');
    expect(repo.getTemplate('a')).toBeNull();
    expect(repo.findTemplatesRequiringModel('fn.pth')).toEqual([]);
    expect(repo.findTemplatesRequiringPlugin('p1')).toEqual([]);
  });
});
