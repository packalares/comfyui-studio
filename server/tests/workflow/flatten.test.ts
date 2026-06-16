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

  it('expands sibling wrappers in dependency order so cross-wrapper links resolve', () => {
    // Two sibling wrappers at top level: 'sourceSG' produces an output that
    // 'consumerSG' reads via its input pin. consumerSG appears FIRST in
    // scopeNodes — without topological sort, Pass 1 expands it before
    // sourceSG, so state.wrapperOutputs['sourceSG'] is empty when
    // consumerSG's buildInnerInputSubs runs and the inner -10 link drops.
    const wf = {
      nodes: [
        { id: 10, type: 'consumerSG',
          inputs: [{ name: 'in', link: 500 }],
          outputs: [{ links: [501] }] },
        { id: 11, type: 'sourceSG',
          inputs: [],
          outputs: [{ links: [500] }] },
        { id: 99, type: 'Saver',
          inputs: [{ name: 'x', link: 501 }],
          widgets_values: [] },
      ],
      links: [
        [500, 11, 0, 10, 0, '*'],
        [501, 10, 0, 99, 0, '*'],
      ],
      definitions: {
        subgraphs: [
          { id: 'sourceSG',
            nodes: [{ id: 20, type: 'Source', inputs: [], widgets_values: [] }],
            links: [{ id: 600, origin_id: 20, origin_slot: 0, target_id: -20, target_slot: 0 }],
            inputs: [],
            outputs: [{ linkIds: [600] }] },
          { id: 'consumerSG',
            nodes: [{ id: 30, type: 'Inner',
              inputs: [{ name: 'val', link: 700 }],
              widgets_values: [] }],
            links: [
              { id: 700, origin_id: -10, origin_slot: 0, target_id: 30, target_slot: 0 },
              { id: 701, origin_id: 30, origin_slot: 0, target_id: -20, target_slot: 0 },
            ],
            inputs: [{ name: 'in', type: '*' }],
            outputs: [{ linkIds: [701] }] },
        ],
      },
    };

    const { nodes, links } = flattenWorkflow(wf);
    expect(nodes.has('11:20')).toBe(true);
    expect(nodes.has('10:30')).toBe(true);
    // The inner consumer must receive a link from the sibling source.
    const cross = links.find(l => l.target_id === '10:30');
    expect(cross).toBeDefined();
    expect(cross?.origin_id).toBe('11:20');
    expect(cross?.origin_slot).toBe(0);
  });

  it('passes through bypassed (mode=4) wrappers by type-matched input', () => {
    // Wrapper is bypassed; ComfyUI's native runtime treats this as a
    // transparent shunt: each output port reads from the wrapper's
    // first same-type input. Downstream non-bypassed consumers must keep
    // their wires through the bypass instead of going dangling.
    const wf = {
      nodes: [
        { id: 10, type: 'Source', inputs: [], outputs: [{ links: [500] }] },
        {
          id: 11, type: 'passSG',
          mode: 4, // bypassed wrapper
          inputs: [{ name: 'latent', type: 'LATENT', link: 500 }],
          outputs: [{ name: 'latent_out', type: 'LATENT', links: [501] }],
        },
        { id: 99, type: 'Sink', inputs: [{ name: 'x', link: 501 }], widgets_values: [] },
      ],
      links: [
        [500, 10, 0, 11, 0, 'LATENT'],
        [501, 11, 0, 99, 0, 'LATENT'],
      ],
      definitions: {
        subgraphs: [
          {
            id: 'passSG',
            nodes: [{ id: 20, type: 'NeverExecuted', inputs: [], widgets_values: [] }],
            links: [],
            inputs: [{ name: 'latent', type: 'LATENT' }],
            outputs: [{ linkIds: [] }],
          },
        ],
      },
    };
    const { nodes, links } = flattenWorkflow(wf);
    // Sink should receive a direct link from Source (10) — the bypassed
    // wrapper transparently forwards the LATENT, just like ComfyUI does.
    expect(nodes.has('99')).toBe(true);
    expect(nodes.has('10')).toBe(true);
    // The inner subgraph body must NOT be expanded (bypassed = nodes don't run).
    expect(nodes.has('11:20')).toBe(false);
    const sinkLink = links.find(l => l.target_id === '99');
    expect(sinkLink).toBeDefined();
    expect(sinkLink?.origin_id).toBe('10');
    expect(sinkLink?.origin_slot).toBe(0);
  });

  it('drops the link when a bypassed wrapper has no same-type input', () => {
    // Bypassed wrapper outputs LATENT but only declares a MODEL input —
    // ComfyUI's bypass has no source to passthrough, so downstream loses
    // the link. We do the same.
    const wf = {
      nodes: [
        { id: 10, type: 'ModelSource', inputs: [], outputs: [{ links: [500] }] },
        {
          id: 11, type: 'mismatchSG',
          mode: 4,
          inputs: [{ name: 'model_in', type: 'MODEL', link: 500 }],
          outputs: [{ name: 'latent_out', type: 'LATENT', links: [501] }],
        },
        { id: 99, type: 'Sink', inputs: [{ name: 'x', link: 501 }], widgets_values: [] },
      ],
      links: [
        [500, 10, 0, 11, 0, 'MODEL'],
        [501, 11, 0, 99, 0, 'LATENT'],
      ],
      definitions: {
        subgraphs: [{
          id: 'mismatchSG',
          nodes: [{ id: 20, type: 'X', inputs: [], widgets_values: [] }],
          links: [],
          inputs: [{ name: 'model_in', type: 'MODEL' }],
          outputs: [{ linkIds: [] }],
        }],
      },
    };
    const { links } = flattenWorkflow(wf);
    const sinkLink = links.find(l => l.target_id === '99');
    expect(sinkLink).toBeUndefined();
  });

  it('keeps the legacy matched-bypass behaviour: bypassed wrapper + bypassed consumer', () => {
    // Pattern used by OneReward / Klein-4b-distilled templates: the
    // wrapper is bypassed AND its downstream non-wrapper consumer is
    // also bypassed. Adding passthrough on the wrapper must NOT change
    // this: the bypassed consumer is kept in the flat map (so resolveInput
    // can followBypassed through it) but is skipped at API-prompt
    // emission. The end-to-end ComfyUI behaviour is unchanged.
    const wf = {
      nodes: [
        { id: 10, type: 'Source', inputs: [], outputs: [{ links: [500] }] },
        {
          id: 11, type: 'passSG',
          mode: 4,
          inputs: [{ name: 'latent', type: 'LATENT', link: 500 }],
          outputs: [{ name: 'latent_out', type: 'LATENT', links: [501] }],
        },
        {
          id: 50, type: 'BypassedConsumer',
          mode: 4,
          inputs: [{ name: 'x', link: 501 }],
          widgets_values: [],
        },
      ],
      links: [
        [500, 10, 0, 11, 0, 'LATENT'],
        [501, 11, 0, 50, 0, 'LATENT'],
      ],
      definitions: {
        subgraphs: [{
          id: 'passSG',
          nodes: [{ id: 20, type: 'X', inputs: [], widgets_values: [] }],
          links: [],
          inputs: [{ name: 'latent', type: 'LATENT' }],
          outputs: [{ linkIds: [] }],
        }],
      },
    };
    const { nodes } = flattenWorkflow(wf);
    // BypassedConsumer kept in map (followBypassed can walk through it)
    // but the inner subgraph body is skipped (bypassed wrapper doesn't run).
    expect(nodes.has('50')).toBe(true);
    expect(nodes.get('50')?.mode).toBe(4);
    expect(nodes.has('11:20')).toBe(false);
    expect(nodes.has('10')).toBe(true);
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
