// Inner-subgraph widget enumeration — the Phase 3 extension to the
// "Expose fields" pipeline. Verifies:
//   1. Buried widgets surface with compound nodeIds (`wrapperId:innerId`).
//   2. Widgets already covered by the wrapper's proxyWidgets list are
//      NOT double-emitted by the walker.
//   3. Nested subgraphs chain prefixes (`outer:mid:leaf`).
//   4. A self-referential subgraph cycle is stopped by the depth cap.
//   5. Enumerated compound nodeIds round-trip through flattenWorkflow —
//      i.e. `flatNodes.get(widget.nodeId)` is defined and the flat node's
//      objectInfo schema has `widget.widgetName` in its widget list.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it, beforeAll, beforeEach } from 'vitest';
import { flattenWorkflow } from '../../src/services/workflow/flatten/index.js';
import {
  resetObjectInfoCache,
  seedObjectInfoCache,
} from '../../src/services/workflow/objectInfo.js';
import {
  enumerateTemplateWidgets,
  widgetNamesFor,
} from '../../src/services/workflow/rawWidgets/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, '..', 'fixtures', 'workflows');

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(FIX, rel), 'utf8'));
}

// Minimal objectInfo for the synthetic fixtures below. Real LTX2 tests
// seed the full objectInfo from the fixture file.
const MINI_INFO = {
  KSampler: {
    input: {
      required: {
        seed: ['INT', { min: 0 }],
        steps: ['INT', { min: 1 }],
        cfg: ['FLOAT', {}],
        sampler_name: [['euler', 'dpmpp_2m']],
        scheduler: [['normal', 'karras']],
        denoise: ['FLOAT', { min: 0, max: 1 }],
        model: ['MODEL'],
      },
    },
  },
  KSamplerSelect: {
    input: {
      required: {
        sampler_name: [['euler', 'dpmpp_2m']],
      },
    },
  },
} satisfies Record<string, Record<string, unknown>>;

function makeWorkflow(extra?: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    nodes: [
      {
        id: 267,
        type: 'sg-uuid',
        properties: { proxyWidgets: [] },
        widgets_values: [],
      },
    ],
    definitions: {
      subgraphs: [
        {
          id: 'sg-uuid',
          name: 'Video Generation (LTX-2.3)',
          nodes: [
            {
              id: 216,
              type: 'KSampler',
              widgets_values: [42, 'randomize', 20, 7.5, 'euler', 'normal', 1.0],
            },
          ],
        },
      ],
    },
    ...extra,
  };
}

describe('enumerateTemplateWidgets — inner subgraph walk', () => {
  beforeAll(() => {
    resetObjectInfoCache();
    seedObjectInfoCache(MINI_INFO);
  });

  it('emits inner widgets with compound nodeId `<wrapperId>:<innerId>`', async () => {
    const out = await enumerateTemplateWidgets(makeWorkflow(), 'phase3-smoke');
    const seedWidget = out.find(w => w.widgetName === 'seed' && w.nodeId === '267:216');
    expect(seedWidget).toBeDefined();
    expect(seedWidget?.scopeName).toBe('Video Generation (LTX-2.3)');
    // Label is the widget-side portion only ("Seed"); the subgraph + node
    // context now lives on `scopeLabel` so the UI can render it as a tooltip.
    expect(seedWidget?.label).toBe('Seed');
    expect(seedWidget?.scopeLabel).toBe('Video Generation (LTX-2.3) · KSampler');
    // formClaimed must be false for inner widgets — they're strictly opt-in.
    expect(seedWidget?.formClaimed).toBe(false);
  });

  it('dedupes inner widgets already covered by proxyWidgets', async () => {
    const wf = makeWorkflow();
    const wrapper = (wf.nodes as Array<Record<string, unknown>>)[0];
    (wrapper.properties as Record<string, unknown>).proxyWidgets = [[216, 'sampler_name']];
    const out = await enumerateTemplateWidgets(wf, 'phase3-dedupe');
    const compoundMatches = out.filter(
      w => w.nodeId === '267:216' && w.widgetName === 'sampler_name',
    );
    // Proxy already covers sampler_name on inner 216 — must NOT re-emit it.
    expect(compoundMatches.length).toBe(0);
    // Other widgets on the same inner node still surface.
    expect(out.some(w => w.nodeId === '267:216' && w.widgetName === 'steps')).toBe(true);
  });

  it('chains prefixes across nested subgraphs', async () => {
    const wf = {
      nodes: [
        {
          id: 500,
          type: 'outerSG',
          properties: { proxyWidgets: [] },
          widgets_values: [],
        },
      ],
      definitions: {
        subgraphs: [
          {
            id: 'outerSG',
            name: 'Outer',
            nodes: [
              {
                id: 51,
                type: 'innerSG',
                properties: { proxyWidgets: [] },
                widgets_values: [],
              },
            ],
          },
          {
            id: 'innerSG',
            name: 'Inner',
            nodes: [
              {
                id: 20,
                type: 'KSamplerSelect',
                widgets_values: ['dpmpp_2m'],
              },
            ],
          },
        ],
      },
    };
    const out = await enumerateTemplateWidgets(wf, 'phase3-nested');
    const leaf = out.find(w => w.nodeId === '500:51:20' && w.widgetName === 'sampler_name');
    expect(leaf).toBeDefined();
    expect(leaf?.scopeName).toBe('Inner');
  });

  it('bails out cleanly on a self-referential subgraph cycle', async () => {
    // Hand-build a def whose inner node is itself a wrapper of the same
    // subgraph id — a pathological cycle. The walker must stop without
    // blowing the stack; MAX_SUBGRAPH_DEPTH = 8 in subgraphWalk.ts.
    const wf = {
      nodes: [
        {
          id: 900,
          type: 'loopSG',
          properties: { proxyWidgets: [] },
          widgets_values: [],
        },
      ],
      definitions: {
        subgraphs: [
          {
            id: 'loopSG',
            name: 'Loop',
            nodes: [
              {
                id: 1,
                type: 'loopSG',
                properties: { proxyWidgets: [] },
                widgets_values: [],
              },
            ],
          },
        ],
      },
    };
    const run = async (): Promise<unknown> => enumerateTemplateWidgets(wf, 'phase3-cycle');
    await expect(run()).resolves.toBeDefined();
  });
});

describe('enumerateTemplateWidgets — flatten round-trip (real LTX2 fixture)', () => {
  beforeEach(() => {
    resetObjectInfoCache();
    seedObjectInfoCache(
      readJson('ltx2_i2v.objectInfo.json') as Record<string, Record<string, unknown>>,
    );
  });

  it('every emitted compound nodeId maps to a real FlatNode whose schema carries the widget', async () => {
    const wf = readJson('ltx2_i2v.workflow.json');
    const widgets = await enumerateTemplateWidgets(wf, 'ltx2-roundtrip-test');
    const { nodes: flatNodes } = flattenWorkflow(wf);

    // Every inner (compound-id) widget we emitted must (a) land on a real
    // FlatNode and (b) be a legitimate widget of that node's class_type.
    const inner = widgets.filter(w => w.nodeId.includes(':'));
    expect(inner.length).toBeGreaterThan(0);

    const objectInfo = readJson('ltx2_i2v.objectInfo.json') as Record<string, Record<string, unknown>>;
    for (const w of inner) {
      const flat = flatNodes.get(w.nodeId);
      expect(flat, `FlatNode missing for ${w.nodeId}`).toBeDefined();
      const names = widgetNamesFor(objectInfo, flat!.type);
      expect(
        names.includes(w.widgetName),
        `schema for ${flat!.type} (node ${w.nodeId}) lacks widget ${w.widgetName}`,
      ).toBe(true);
    }
  });

  it('does not double-emit the 13 proxy-covered widgets for video_ltx2_3_i2v', async () => {
    const wf = readJson('ltx2_i2v.workflow.json');
    const widgets = await enumerateTemplateWidgets(wf, 'ltx2-proxy-dedupe');

    // Find the wrapper's proxyWidgets list.
    const wrapper = (wf.nodes as Array<Record<string, unknown>>).find(
      n => (n.properties as Record<string, unknown> | undefined)?.proxyWidgets,
    );
    expect(wrapper).toBeDefined();
    const wrapperId = String(wrapper!.id);
    const proxyList = (wrapper!.properties as Record<string, unknown>).proxyWidgets as Array<[string, string]>;

    for (const [innerId, widgetName] of proxyList) {
      if (innerId === '-1') continue;
      const compoundId = `${wrapperId}:${innerId}`;
      const hit = widgets.find(w => w.nodeId === compoundId && w.widgetName === widgetName);
      expect(
        hit,
        `proxy-covered widget (${compoundId}, ${widgetName}) must not be re-emitted as a raw-widget`,
      ).toBeUndefined();
    }
  });
});
