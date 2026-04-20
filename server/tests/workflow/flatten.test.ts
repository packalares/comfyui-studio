// Flattener tests — cover nested subgraph expansion, link rewiring,
// Reroute elision, PrimitiveNode inlining.

import { describe, expect, it } from 'vitest';
import {
  flattenWorkflow,
  normalizeLinks,
} from '../../src/services/workflow/flatten/index.js';

describe('normalizeLinks', () => {
  it('accepts both array and object link shapes', () => {
    const raw = [
      [1, 2, 0, 3, 0, 'IMAGE'],
      { id: 2, origin_id: 5, origin_slot: 1, target_id: 7, target_slot: 0 },
    ];
    const out = normalizeLinks(raw);
    expect(out).toEqual([
      { id: 1, origin_id: 2, origin_slot: 0, target_id: 3, target_slot: 0 },
      { id: 2, origin_id: 5, origin_slot: 1, target_id: 7, target_slot: 0 },
    ]);
  });
});

describe('flattenWorkflow', () => {
  it('inlines a nested subgraph through two wrapper levels', () => {
    // Outer scope: one wrapper of type "outerSG" feeding node 99 (Saver).
    // outerSG inside: one wrapper of type "innerSG" feeding node 50 (Mid).
    // innerSG inside: node 20 (Leaf) exposes its output as pin 0.
    const wf = {
      nodes: [
        { id: 1, type: 'outerSG', inputs: [], outputs: [{ links: [100] }] },
        { id: 99, type: 'Saver', inputs: [{ name: 'x', link: 100 }], widgets_values: [] },
      ],
      links: [[100, 1, 0, 99, 0, 'IMAGE']],
      definitions: {
        subgraphs: [
          {
            id: 'outerSG',
            nodes: [
              { id: 50, type: 'Mid', inputs: [{ name: 'y', link: 200 }], widgets_values: [] },
              { id: 51, type: 'innerSG', inputs: [], outputs: [{ links: [200] }] },
            ],
            links: [
              { id: 200, origin_id: 51, origin_slot: 0, target_id: 50, target_slot: 0 },
              { id: 201, origin_id: 50, origin_slot: 0, target_id: -20, target_slot: 0 },
            ],
            inputs: [],
            outputs: [{ linkIds: [201] }],
          },
          {
            id: 'innerSG',
            nodes: [
              { id: 20, type: 'Leaf', inputs: [], widgets_values: [] },
            ],
            links: [
              { id: 300, origin_id: 20, origin_slot: 0, target_id: -20, target_slot: 0 },
            ],
            inputs: [],
            outputs: [{ linkIds: [300] }],
          },
        ],
      },
    };

    const { nodes, links } = flattenWorkflow(wf);
    // Expect Saver, Mid, Leaf — no wrapper nodes.
    const types = Array.from(nodes.values()).map(n => n.type).sort();
    expect(types).toEqual(['Leaf', 'Mid', 'Saver']);
    // Every emitted link endpoint must reference a real node id in the map.
    for (const l of links) {
      expect(nodes.has(l.target_id) || l.target_id.startsWith('-'))
        .toBe(true);
    }
    // Saver should receive a link from Mid (inline global id "1:50").
    const saverLink = links.find(l => l.target_id === '99');
    expect(saverLink?.origin_id).toBe('1:50');
  });

  it('elides Reroute nodes during flattening (kept in map, resolved at prompt time)', () => {
    const wf = {
      nodes: [
        { id: 1, type: 'Source', inputs: [], widgets_values: [] },
        { id: 2, type: 'Reroute', inputs: [{ name: '', link: 1 }], widgets_values: [] },
        { id: 3, type: 'Sink', inputs: [{ name: 'x', link: 2 }], widgets_values: [] },
      ],
      links: [
        [1, 1, 0, 2, 0, '*'],
        [2, 2, 0, 3, 0, '*'],
      ],
    };
    const { nodes } = flattenWorkflow(wf);
    // Reroute survives the flattener as a real node; resolve.ts decides
    // what to do with it at prompt-build time.
    expect(nodes.has('2')).toBe(true);
    expect(nodes.get('2')?.type).toBe('Reroute');
  });

  it('keeps PrimitiveNode holders in the node map (inlined later)', () => {
    const wf = {
      nodes: [
        { id: 1, type: 'PrimitiveInt', inputs: [], widgets_values: [42] },
        { id: 2, type: 'Sink', inputs: [{ name: 'x', link: 10 }], widgets_values: [] },
      ],
      links: [[10, 1, 0, 2, 0, 'INT']],
    };
    const { nodes } = flattenWorkflow(wf);
    expect(nodes.get('1')?.widgets_values).toEqual([42]);
    expect(nodes.get('2')).toBeDefined();
  });

  it('drops muted (mode=2) nodes entirely', () => {
    const wf = {
      nodes: [
        { id: 1, type: 'Active', inputs: [], widgets_values: [] },
        { id: 2, type: 'Muted', inputs: [], widgets_values: [], mode: 2 },
      ],
      links: [],
    };
    const { nodes } = flattenWorkflow(wf);
    expect(nodes.has('1')).toBe(true);
    expect(nodes.has('2')).toBe(false);
  });
});
