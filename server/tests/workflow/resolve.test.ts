// Link-resolution tests — PrimitiveNode inline, Get/Set pair, Reroute hop,
// bypassed-node rerouting.

import { describe, expect, it } from 'vitest';
import type { FlatLink, FlatNode } from '../../src/services/workflow/flatten/index.js';
import {
  buildSetterMap,
  resolveInput,
  type ResolveCtx,
} from '../../src/services/workflow/resolve.js';

function makeCtx(
  nodes: FlatNode[],
  links: FlatLink[],
  objectInfo: Record<string, Record<string, unknown>> = {},
): ResolveCtx {
  const nodeMap = new Map<string, FlatNode>();
  for (const n of nodes) nodeMap.set(n.id, n);
  const linkMap = new Map<number, FlatLink>();
  for (const l of links) linkMap.set(l.id, l);
  const base = { linkMap, nodes: nodeMap, objectInfo };
  const setterMap = buildSetterMap(base);
  return { ...base, setterMap };
}

describe('resolveInput', () => {
  it('inlines a PrimitiveNode literal value', () => {
    const ctx = makeCtx(
      [
        { id: 'p', type: 'PrimitiveInt', inputs: [], widgets_values: [7] },
        { id: 's', type: 'Sink', inputs: [{ name: 'x', link: 1 }], widgets_values: [] },
      ],
      [{ id: 1, origin_id: 'p', origin_slot: 0, target_id: 's', target_slot: 0 }],
    );
    const r = resolveInput(1, ctx);
    expect(r).toEqual({ kind: 'literal', value: 7 });
  });

  it('follows a Reroute hop to the real source', () => {
    const ctx = makeCtx(
      [
        { id: 'src', type: 'Real', inputs: [], widgets_values: [] },
        { id: 'rr', type: 'Reroute', inputs: [{ name: '', link: 1 }], widgets_values: [] },
        { id: 'dst', type: 'Sink', inputs: [{ name: 'x', link: 2 }], widgets_values: [] },
      ],
      [
        { id: 1, origin_id: 'src', origin_slot: 0, target_id: 'rr', target_slot: 0 },
        { id: 2, origin_id: 'rr', origin_slot: 0, target_id: 'dst', target_slot: 0 },
      ],
    );
    const r = resolveInput(2, ctx);
    expect(r).toEqual({ kind: 'ref', nodeId: 'src', slot: 0 });
  });

  it('resolves a Get/Set variable pair to the SetNode input source', () => {
    const ctx = makeCtx(
      [
        { id: 'src', type: 'Real', inputs: [], widgets_values: [] },
        {
          id: 'set', type: 'SetNode',
          inputs: [{ name: 'value', link: 1 }],
          widgets_values: ['my_var'],
        },
        {
          id: 'get', type: 'GetNode',
          inputs: [], widgets_values: ['my_var'],
        },
        { id: 'dst', type: 'Sink', inputs: [{ name: 'x', link: 2 }], widgets_values: [] },
      ],
      [
        { id: 1, origin_id: 'src', origin_slot: 0, target_id: 'set', target_slot: 0 },
        { id: 2, origin_id: 'get', origin_slot: 0, target_id: 'dst', target_slot: 0 },
      ],
    );
    const r = resolveInput(2, ctx);
    expect(r).toEqual({ kind: 'ref', nodeId: 'src', slot: 0 });
  });

  it('routes a bypassed (mode 4) node by matching output type to an input type', () => {
    // Origin of the requested link is a bypassed node whose output slot 0
    // is type "IMAGE". We should hop through to the input whose spec also
    // starts with "IMAGE".
    const objectInfo = {
      Bypassed: {
        input: { required: { image_in: ['IMAGE'], mask_in: ['MASK'] } },
        output: ['IMAGE'],
      },
    } satisfies Record<string, Record<string, unknown>>;
    const ctx = makeCtx(
      [
        { id: 'src', type: 'RealSrc', inputs: [], widgets_values: [] },
        {
          id: 'byp', type: 'Bypassed', mode: 4,
          inputs: [
            { name: 'image_in', link: 1 },
            { name: 'mask_in', link: 2 },
          ],
          widgets_values: [],
        },
        { id: 'dst', type: 'Sink', inputs: [{ name: 'x', link: 3 }], widgets_values: [] },
      ],
      [
        { id: 1, origin_id: 'src', origin_slot: 0, target_id: 'byp', target_slot: 0 },
        { id: 2, origin_id: 'src', origin_slot: 0, target_id: 'byp', target_slot: 1 },
        { id: 3, origin_id: 'byp', origin_slot: 0, target_id: 'dst', target_slot: 0 },
      ],
      objectInfo,
    );
    const r = resolveInput(3, ctx);
    expect(r).toEqual({ kind: 'ref', nodeId: 'src', slot: 0 });
  });
});
