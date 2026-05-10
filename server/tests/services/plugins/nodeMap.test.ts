// Tests for the Manager-backed class_type -> plugin resolver.
//
// We mock `fetch` directly so the tests never touch ComfyUI. Coverage:
//   - Inverted-index shape (multi-class / multi-plugin / title_aux / cnr_id).
//   - 1 h TTL + `invalidate()` forces a refetch.
//   - Manager unreachable degrades gracefully (every class_type returned
//     with `matches: []`) and logs the warning once.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveNodeTypes,
  invalidate,
  _seedForTests,
} from '../../../src/services/plugins/nodes.js';

describe('nodeMap.service', () => {
  beforeEach(() => {
    invalidate();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    invalidate();
  });

  it('builds an inverted class_type -> plugin matches index', async () => {
    _seedForTests({
      'https://github.com/alice/pack-a': [
        ['AliceLoader', 'AliceSaver'],
        { title_aux: 'Pack A', cnr_id: 'pack-a' },
      ],
      'https://github.com/bob/pack-b': [
        ['BobNode', 'AliceLoader'], // class_type collision with pack-a
        { title_aux: 'Pack B' },
      ],
    });
    const out = await resolveNodeTypes(['AliceLoader', 'BobNode', 'AliceSaver', 'Unknown']);
    // Three resolved + one unresolved.
    const byType = new Map(out.map((r) => [r.classType, r]));
    // AliceLoader is owned by BOTH packs — preserve every match.
    expect(byType.get('AliceLoader')?.matches.map((m) => m.repo).sort()).toEqual([
      'https://github.com/alice/pack-a',
      'https://github.com/bob/pack-b',
    ]);
    // Title comes from title_aux when present.
    const aMatch = byType.get('AliceSaver')?.matches[0];
    expect(aMatch?.title).toBe('Pack A');
    expect(aMatch?.cnr_id).toBe('pack-a');
    // BobNode: single match, no cnr_id.
    const bMatch = byType.get('BobNode')?.matches[0];
    expect(bMatch?.title).toBe('Pack B');
    expect(bMatch?.cnr_id).toBeUndefined();
    // Unknown: zero-match row (preserved for UI "unresolved" state).
    expect(byType.get('Unknown')?.matches).toEqual([]);
  });

  it('caches for an hour and `invalidate()` forces a refetch', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        'https://github.com/x/y': [['ClassA'], { title_aux: 'Y' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    // First call fetches.
    await resolveNodeTypes(['ClassA']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Subsequent call within TTL uses the in-memory cache.
    await resolveNodeTypes(['ClassA']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Invalidate -> next call refetches.
    invalidate();
    await resolveNodeTypes(['ClassA']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('degrades to zero-match rows when Manager is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const out = await resolveNodeTypes(['ClassA', 'ClassB']);
    expect(out).toHaveLength(2);
    for (const row of out) {
      expect(row.matches).toEqual([]);
    }
  });

  it('skips malformed entries without throwing', async () => {
    _seedForTests({
      // Not an array.
      'https://github.com/bad/one': 'garbage' as unknown as never,
      // Empty classes list.
      'https://github.com/bad/two': [[], { title_aux: 'empty' }],
      // Valid row so we have something to resolve.
      'https://github.com/good/pack': [['GoodNode'], { title_aux: 'Good' }],
    });
    const out = await resolveNodeTypes(['GoodNode']);
    expect(out[0].matches).toHaveLength(1);
    expect(out[0].matches[0].repo).toBe('https://github.com/good/pack');
  });

  it('normalizes repo keys (strips trailing slash / .git)', async () => {
    _seedForTests({
      'https://github.com/x/y/': [['ClassA'], { title_aux: 'Y' }],
      'https://github.com/x/y.git': [['ClassB'], { title_aux: 'Y' }],
    });
    const out = await resolveNodeTypes(['ClassA', 'ClassB']);
    for (const row of out) {
      expect(row.matches[0].repo).toBe('https://github.com/x/y');
    }
  });
});
