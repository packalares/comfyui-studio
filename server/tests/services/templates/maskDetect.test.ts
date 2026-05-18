// Unit tests for the mask-kind detector.
//
// Uses minimal hand-built flat graphs rather than full workflow fixtures so
// tests remain fast and self-contained. The detector only needs the flat node
// map and link list produced by flattenWorkflow; the test helpers reproduce
// that shape directly.

import { describe, expect, it } from 'vitest';
import { detectMaskKindsForLoadImage } from '../../../src/services/templates/formFieldPlan/maskDetect.js';
import type { FlatLink, FlatNode } from '../../../src/services/workflow/flatten/index.js';

// -----------------------------------------------------------------------
// Minimal flat-graph factory helpers
// -----------------------------------------------------------------------

function makeNode(id: string, type: string): FlatNode {
  return { id, type, inputs: [], widgets_values: [] };
}

function makeLink(id: number, originId: string, originSlot: number, targetId: string, targetSlot: number): FlatLink {
  return { id, origin_id: originId, origin_slot: originSlot, target_id: targetId, target_slot: targetSlot };
}

function buildGraph(
  nodeDefs: Array<{ id: string; type: string }>,
  linkDefs: Array<{ id: number; from: string; fromSlot: number; to: string; toSlot: number }>,
): { nodes: Map<string, FlatNode>; links: FlatLink[] } {
  const nodes = new Map<string, FlatNode>();
  for (const n of nodeDefs) nodes.set(n.id, makeNode(n.id, n.type));
  const links: FlatLink[] = linkDefs.map(l => makeLink(l.id, l.from, l.fromSlot, l.to, l.toSlot));
  return { nodes, links };
}

// -----------------------------------------------------------------------
// Tests: brush / inpainting
// -----------------------------------------------------------------------

describe('detectMaskKindsForLoadImage — brush cases', () => {
  it('detects brush when MASK slot (1) reaches InpaintModelConditioning', () => {
    const { nodes, links } = buildGraph(
      [
        { id: '1', type: 'LoadImage' },
        { id: '2', type: 'InpaintModelConditioning' },
      ],
      [{ id: 1, from: '1', fromSlot: 1, to: '2', toSlot: 0 }],
    );
    expect(detectMaskKindsForLoadImage(nodes, links, '1')).toEqual([{ kind: 'brush' }]);
  });

  it('detects brush when MASK slot reaches SetLatentNoiseMask', () => {
    const { nodes, links } = buildGraph(
      [
        { id: '10', type: 'LoadImage' },
        { id: '20', type: 'SetLatentNoiseMask' },
      ],
      [{ id: 1, from: '10', fromSlot: 1, to: '20', toSlot: 1 }],
    );
    expect(detectMaskKindsForLoadImage(nodes, links, '10')).toEqual([{ kind: 'brush' }]);
  });

  it('detects brush through an intermediate node in the mask chain', () => {
    // LoadImage.MASK → MaskBlur (passthrough) → InpaintModelConditioning
    const { nodes, links } = buildGraph(
      [
        { id: '1', type: 'LoadImage' },
        { id: '2', type: 'MaskBlur' },
        { id: '3', type: 'InpaintModelConditioning' },
      ],
      [
        { id: 1, from: '1', fromSlot: 1, to: '2', toSlot: 0 },
        { id: 2, from: '2', fromSlot: 0, to: '3', toSlot: 0 },
      ],
    );
    expect(detectMaskKindsForLoadImage(nodes, links, '1')).toEqual([{ kind: 'brush' }]);
  });
});

// -----------------------------------------------------------------------
// Tests: pad / outpainting
// -----------------------------------------------------------------------

describe('detectMaskKindsForLoadImage — pad cases', () => {
  it('detects pad when IMAGE slot (0) reaches ImagePadForOutpaint', () => {
    const { nodes, links } = buildGraph(
      [
        { id: '5', type: 'LoadImage' },
        { id: '6', type: 'ImagePadForOutpaint' },
      ],
      [{ id: 1, from: '5', fromSlot: 0, to: '6', toSlot: 0 }],
    );
    const result = detectMaskKindsForLoadImage(nodes, links, '5');
    expect(result).toEqual([{ kind: 'pad', padTargetNodeId: '6' }]);
  });

  it('returns the correct flat id for the pad node (compound id from a subgraph)', () => {
    const { nodes, links } = buildGraph(
      [
        { id: '100', type: 'LoadImage' },
        { id: '200:3', type: 'ImagePadForOutpaint' },
      ],
      [{ id: 1, from: '100', fromSlot: 0, to: '200:3', toSlot: 0 }],
    );
    const result = detectMaskKindsForLoadImage(nodes, links, '100');
    expect(result).toEqual([{
      kind: 'pad',
      requiresMode: '200',     // wrapper id extracted from the compound flat id
      padTargetNodeId: '200:3',
    }]);
  });
});

// -----------------------------------------------------------------------
// Tests: neither
// -----------------------------------------------------------------------

describe('detectMaskKindsForLoadImage — plain workflow', () => {
  it('returns an empty array when no inpainting or outpainting consumer is reachable', () => {
    const { nodes, links } = buildGraph(
      [
        { id: '1', type: 'LoadImage' },
        { id: '2', type: 'CLIPVisionEncode' },
        { id: '3', type: 'KSampler' },
      ],
      [
        { id: 1, from: '1', fromSlot: 0, to: '2', toSlot: 0 },
        { id: 2, from: '2', fromSlot: 0, to: '3', toSlot: 0 },
      ],
    );
    expect(detectMaskKindsForLoadImage(nodes, links, '1')).toEqual([]);
  });

  it('returns an empty array when the graph is empty', () => {
    expect(detectMaskKindsForLoadImage(new Map(), [], '1')).toEqual([]);
  });

  it('returns an empty array for a LoadImage with no outgoing links', () => {
    const nodes = new Map([['1', makeNode('1', 'LoadImage')]]);
    expect(detectMaskKindsForLoadImage(nodes, [], '1')).toEqual([]);
  });
});

// -----------------------------------------------------------------------
// Tests: BOTH brush and pad can be detected when both patterns match
// (the multi-pipeline case, e.g. OneReward inpaint + outpaint)
// -----------------------------------------------------------------------

describe('detectMaskKindsForLoadImage — multi-pipeline (mode-aware)', () => {
  it('returns BOTH brush and pad when MASK reaches a brush consumer AND IMAGE reaches ImagePadForOutpaint', () => {
    const { nodes, links } = buildGraph(
      [
        { id: '1', type: 'LoadImage' },
        { id: '108:38', type: 'InpaintModelConditioning' },   // inside subgraph 108
        { id: '110:75', type: 'ImagePadForOutpaint' },        // inside subgraph 110
      ],
      [
        { id: 1, from: '1', fromSlot: 1, to: '108:38', toSlot: 0 },
        { id: 2, from: '1', fromSlot: 0, to: '110:75', toSlot: 0 },
      ],
    );
    const result = detectMaskKindsForLoadImage(nodes, links, '1');
    expect(result).toContainEqual({ kind: 'brush', requiresMode: '108' });
    expect(result).toContainEqual({
      kind: 'pad',
      requiresMode: '110',
      padTargetNodeId: '110:75',
    });
    expect(result.length).toBe(2);
  });

  it('dedupes multiple brush consumers within the same subgraph', () => {
    const { nodes, links } = buildGraph(
      [
        { id: '1', type: 'LoadImage' },
        { id: '108:38', type: 'InpaintModelConditioning' },
        { id: '108:73', type: 'SetLatentNoiseMask' },
        // Same subgraph (108), two different brush consumers — should
        // collapse to a single { kind: 'brush', requiresMode: '108' }.
      ],
      [
        { id: 1, from: '1', fromSlot: 1, to: '108:38', toSlot: 0 },
        { id: 2, from: '1', fromSlot: 1, to: '108:73', toSlot: 1 },
      ],
    );
    const result = detectMaskKindsForLoadImage(nodes, links, '1');
    expect(result).toEqual([{ kind: 'brush', requiresMode: '108' }]);
  });

  it('omits requiresMode for top-level consumers (id has no compound prefix)', () => {
    const { nodes, links } = buildGraph(
      [
        { id: '1', type: 'LoadImage' },
        { id: '2', type: 'InpaintModelConditioning' },        // top-level
      ],
      [{ id: 1, from: '1', fromSlot: 1, to: '2', toSlot: 0 }],
    );
    const result = detectMaskKindsForLoadImage(nodes, links, '1');
    expect(result).toEqual([{ kind: 'brush' }]);   // no requiresMode
  });
});
