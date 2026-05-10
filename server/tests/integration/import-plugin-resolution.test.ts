// Integration — stage a fake workflow with a known class_type and assert
// the resulting manifest's `plugins` array carries the Manager-resolved
// repo URL. The Manager lookup is seeded via the nodeMap service's
// `_seedForTests` hook so no network I/O is needed.
//
// We also seed the ObjectInfo cache with an empty set so the built-in
// filter doesn't strip our test class types.

import { beforeEach, describe, expect, it } from 'vitest';
import { stageFromJson } from '../../src/services/templates/importZip.js';
import {
  invalidate as invalidateNodeMap,
  _seedForTests as seedNodeMap,
} from '../../src/services/plugins/nodes.js';
import {
  seedObjectInfoCache,
  resetObjectInfoCache,
} from '../../src/services/workflow/objectInfo.js';

function workflowWith(classTypes: string[]): Record<string, unknown> {
  return {
    nodes: classTypes.map((t, i) => ({ id: i + 1, type: t })),
  };
}

describe('import plugin resolution (end-to-end staging)', () => {
  beforeEach(() => {
    invalidateNodeMap();
    resetObjectInfoCache();
    // No built-ins in the test ObjectInfo so every class type is a
    // candidate for Manager resolution.
    seedObjectInfoCache({});
  });

  it('populates the staged manifest plugins with Manager-resolved repos', async () => {
    seedNodeMap({
      'https://github.com/alice/fancy-pack': [
        ['FancyNode'],
        { title_aux: 'Fancy Pack', cnr_id: 'fancy-pack' },
      ],
    });
    const staged = await stageFromJson(workflowWith(['FancyNode']), {
      source: 'upload',
    });
    expect(staged.workflows).toHaveLength(1);
    const plugins = staged.workflows[0].plugins;
    // Single resolution row with one match pointing at the seeded repo.
    expect(plugins).toHaveLength(1);
    expect(plugins[0].classType).toBe('FancyNode');
    expect(plugins[0].matches).toEqual([
      { repo: 'https://github.com/alice/fancy-pack', title: 'Fancy Pack', cnr_id: 'fancy-pack' },
    ]);
  });

  it('records unresolved class types as zero-match rows', async () => {
    seedNodeMap({}); // empty catalog
    const staged = await stageFromJson(workflowWith(['OrphanNode']), {
      source: 'upload',
    });
    const plugins = staged.workflows[0].plugins;
    expect(plugins).toHaveLength(1);
    expect(plugins[0].classType).toBe('OrphanNode');
    expect(plugins[0].matches).toEqual([]);
  });

  it('unions cheap aux_id hits with Manager-resolved matches + dedupes', async () => {
    // Workflow carries BOTH an aux_id-stamped node and an unstamped one
    // whose class_type the Manager index knows.
    seedNodeMap({
      'https://github.com/carol/new-pack': [
        ['NewNode'],
        { title_aux: 'New Pack' },
      ],
      // This one matches the aux_id already on the workflow — the async
      // extractor should drop the aux fallback for it.
      'https://github.com/alice/owned-pack': [
        ['SomeNode'],
        { title_aux: 'Owned' },
      ],
    });
    const wf: Record<string, unknown> = {
      nodes: [
        { id: 1, type: 'SomeNode', properties: { aux_id: 'alice/owned-pack' } },
        { id: 2, type: 'NewNode' },
      ],
    };
    const staged = await stageFromJson(wf, { source: 'upload' });
    const plugins = staged.workflows[0].plugins;
    // Two class_types -> two Manager resolutions, no duplicate aux rows.
    expect(plugins).toHaveLength(2);
    const byRepo = plugins
      .flatMap((p) => p.matches.map((m) => m.repo))
      .sort();
    expect(byRepo).toEqual([
      'https://github.com/alice/owned-pack',
      'https://github.com/carol/new-pack',
    ]);
  });

  it('keeps aux_id fallback when Manager doesn\'t recognize the repo', async () => {
    seedNodeMap({}); // Manager has nothing
    const wf: Record<string, unknown> = {
      nodes: [
        { id: 1, type: 'SomeNode', properties: { aux_id: 'zed/niche-pack' } },
      ],
    };
    const staged = await stageFromJson(wf, { source: 'upload' });
    const plugins = staged.workflows[0].plugins;
    // At least one aux-only synthetic row for the niche-pack key.
    const auxRows = plugins.filter((p) => p.matches.some((m) => m.repo === 'zed/niche-pack'));
    expect(auxRows.length).toBeGreaterThan(0);
  });
});
