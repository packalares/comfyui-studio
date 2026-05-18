// Regression tests for the mode-detect pipeline.
// Uses the image_qwen_image_edit_2509 fixture (two subgraph instances, one
// active, one bypassed) and hand-crafted minimal fixtures for the other cases.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { detectModeFields } from '../../../src/services/templates/formFieldPlan/modeDetect.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.resolve(HERE, '../../fixtures/workflows');

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(FIX, rel), 'utf8'));
}

// -----------------------------------------------------------------------
// Minimal workflow factories (avoid pulling in large fixtures for simple cases)
// -----------------------------------------------------------------------

function makeSubgraphNode(
  id: number,
  type: string,
  mode: number | undefined,
): Record<string, unknown> {
  return {
    id,
    type,
    mode,
    properties: { proxyWidgets: [['6', 'prompt']] },
    inputs: [],
    outputs: [],
  };
}

function makeRegularNode(
  id: number,
  type: string,
  mode: number,
): Record<string, unknown> {
  return { id, type, mode, properties: {}, inputs: [], outputs: [] };
}

function makeMiniWorkflow(
  nodes: Array<Record<string, unknown>>,
  subgraphDefs: Array<{ id: string; name: string; nodes?: unknown[] }> = [],
): Record<string, unknown> {
  return {
    nodes,
    links: [],
    definitions: { subgraphs: subgraphDefs },
  };
}

// -----------------------------------------------------------------------
// image_qwen_image_edit_2509 — real fixture, two subgraphs one active one bypassed
// -----------------------------------------------------------------------

describe('detectModeFields — image_qwen_image_edit_2509 fixture', () => {
  const wf = readJson('image_qwen_image_edit_2509.workflow.json');

  it('returns a mode-select with 2 options', () => {
    const { modeSelect } = detectModeFields(wf);
    expect(modeSelect).not.toBeNull();
    expect(modeSelect!.type).toBe('mode-select');
    expect(modeSelect!.id).toBe('mode');
    expect(modeSelect!.options).toHaveLength(2);
  });

  it('mode-select default is the active subgraph slug', () => {
    const { modeSelect } = detectModeFields(wf);
    // Node 433 is mode=0 (active), node 466 is mode=4 (bypassed) in this fixture.
    expect(modeSelect!.default).toBe('433');
  });

  it('each option lists the OTHER node as bypassNodes', () => {
    const { modeSelect } = detectModeFields(wf);
    const opt433 = modeSelect!.options.find(o => o.value === '433')!;
    const opt466 = modeSelect!.options.find(o => o.value === '466')!;
    expect(opt433.bypassNodes).toEqual([466]);
    expect(opt466.bypassNodes).toEqual([433]);
  });

  it('option labels are non-empty strings', () => {
    const { modeSelect } = detectModeFields(wf);
    for (const opt of modeSelect!.options) {
      expect(typeof opt.label).toBe('string');
      expect(opt.label.length).toBeGreaterThan(0);
    }
  });

  it('common prefix is stripped so labels are compact', () => {
    const { modeSelect } = detectModeFields(wf);
    // Both subgraphs are named "Image Edit (Qwen ...)" — the common prefix
    // should be stripped, leaving distinct suffixes.
    const labels = modeSelect!.options.map(o => o.label);
    // The two labels must differ from each other.
    expect(labels[0]).not.toBe(labels[1]);
  });

  it('stripped labels keep brackets balanced (no orphan ")" )', () => {
    const { modeSelect } = detectModeFields(wf);
    // Regression: the previous LCP walk cut after "Image Edit (Qwen "
    // and left the stripped suffixes with an orphan trailing ")". The
    // bracket-balance walkback should restore the matching "(".
    for (const opt of modeSelect!.options) {
      const open = (opt.label.match(/\(/g) ?? []).length;
      const close = (opt.label.match(/\)/g) ?? []).length;
      expect(open).toBe(close);
    }
    // Both labels should now start with "(Qwen" (the matching open paren
    // got pulled into the suffix).
    const labels = modeSelect!.options.map(o => o.label);
    expect(labels.every(l => l.startsWith('(Qwen'))).toBe(true);
  });
});

// -----------------------------------------------------------------------
// ltx2_i2v — single subgraph instance: no mode-select
// -----------------------------------------------------------------------

describe('detectModeFields — ltx2_i2v fixture (single active subgraph)', () => {
  const wf = readJson('ltx2_i2v.workflow.json');

  it('returns null modeSelect for a workflow with only one subgraph instance', () => {
    const { modeSelect } = detectModeFields(wf);
    expect(modeSelect).toBeNull();
  });

  it('returns empty bypassToggles when no nodes have mode=4', () => {
    const { bypassToggles } = detectModeFields(wf);
    expect(bypassToggles).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------
// Both subgraphs active (both mode=0) — NOT a mutual-exclusion cluster
// -----------------------------------------------------------------------

describe('detectModeFields — both subgraphs active', () => {
  const wf = makeMiniWorkflow([
    makeSubgraphNode(10, 'sg-type-a', 0),
    makeSubgraphNode(11, 'sg-type-b', 0),
  ], [
    { id: 'sg-type-a', name: 'Pipeline A' },
    { id: 'sg-type-b', name: 'Pipeline B' },
  ]);

  it('returns null modeSelect when more than one subgraph is active', () => {
    const { modeSelect } = detectModeFields(wf);
    expect(modeSelect).toBeNull();
  });
});

// -----------------------------------------------------------------------
// Top-level bypassed nodes are NOT surfaced as bypass-toggles. In real
// workflows they almost always represent a whole skipped pipeline (e.g.
// `image_qwen_image_instantx_inpainting_controlnet` ships with its entire
// outpaint pipeline — 22 nodes — bypassed at top level). Emitting a toggle
// per bypassed loader/sampler/saver would flood the form with switches that
// individually break the graph when flipped. Pipeline switching belongs to
// the mode-select cluster path (subgraph-wrapped templates) — top-level
// bypassed nodes are deliberately ignored.
// -----------------------------------------------------------------------

describe('detectModeFields — top-level bypassed nodes are NOT toggleable', () => {
  const wf = makeMiniWorkflow([
    makeSubgraphNode(20, 'sg-type-a', 0),
    makeRegularNode(30, 'LoraLoaderModelOnly', 4),
  ], [
    { id: 'sg-type-a', name: 'Main Pipeline' },
  ]);

  it('emits zero bypass-toggles for a bypassed top-level LoraLoaderModelOnly', () => {
    const { bypassToggles } = detectModeFields(wf);
    expect(bypassToggles).toHaveLength(0);
  });

  it('emits zero bypass-toggles when many top-level nodes are bypassed (the InstantX-style "skipped pipeline" case)', () => {
    const wfMany = makeMiniWorkflow([
      makeSubgraphNode(20, 'sg-type-a', 0),
      makeRegularNode(31, 'UNETLoader', 4),
      makeRegularNode(32, 'CLIPLoader', 4),
      makeRegularNode(33, 'VAELoader', 4),
      makeRegularNode(34, 'KSampler', 4),
      makeRegularNode(35, 'SaveImage', 4),
    ], [
      { id: 'sg-type-a', name: 'Main Pipeline' },
    ]);
    const { bypassToggles } = detectModeFields(wfMany);
    expect(bypassToggles).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------
// Bypassed node inside an active subgraph → compound-id bypass-toggle
// -----------------------------------------------------------------------

describe('detectModeFields — bypassed inner node in active subgraph', () => {
  const wf: Record<string, unknown> = {
    nodes: [
      {
        id: 100,
        type: 'my-sg-type',
        mode: 0,
        properties: { proxyWidgets: [['6', 'prompt']] },
        inputs: [],
        outputs: [],
      },
    ],
    links: [],
    definitions: {
      subgraphs: [{
        id: 'my-sg-type',
        name: 'My Subgraph',
        nodes: [
          { id: 6, type: 'CLIPTextEncode', mode: 0 },
          { id: 7, type: 'LoraLoaderModelOnly', mode: 4, title: 'Removal LoRA' },
        ],
        links: [],
      }],
    },
  };

  it('emits a bypass-toggle with compound id for the inner bypassed node', () => {
    const { bypassToggles } = detectModeFields(wf);
    expect(bypassToggles).toHaveLength(1);
    expect(bypassToggles[0].id).toBe('toggle_100:7');
    expect(bypassToggles[0].bindNodeId).toBe('100:7');
  });

  it('uses the inner node title in the label', () => {
    const { bypassToggles } = detectModeFields(wf);
    expect(bypassToggles[0].label).toBe('Enable Removal LoRA');
  });
});

// -----------------------------------------------------------------------
// Text-plumbing node bypassed — must NOT emit a bypass-toggle
// -----------------------------------------------------------------------

describe('detectModeFields — text plumbing bypassed node is skipped', () => {
  const wf = makeMiniWorkflow([
    makeRegularNode(50, 'StringConcat', 4),
  ]);

  it('does not emit a toggle for TEXT_PLUMBING_CLASS_TYPES nodes', () => {
    const { bypassToggles } = detectModeFields(wf);
    expect(bypassToggles).toHaveLength(0);
  });
});
