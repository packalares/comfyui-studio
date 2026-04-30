// End-to-end regression tests against real ComfyUI workflow fixtures
// captured from the live pod. These pin the form-field-plan behaviour for
// the exact templates the user reported as broken:
//
//   - templates-image_to_real         — Bug 1 (Advanced/Main duplicate Prompt)
//   - image_qwen_image_edit_2509      — Bug 2 (twin-sampler primitives + 2x Prompt)
//   - flux_dev_checkpoint_example     — modern subgraph, sanity
//   - sdxl_simple_example             — legacy flat with multiple Primitives
//
// The objectInfo snapshot is shared across all fixtures (one /object_info
// dump from the same pod that produced the workflow JSONs).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it, beforeAll } from 'vitest';

import { buildFormFieldPlan } from '../../../src/services/templates/formFieldPlan/index.js';
import {
  resetObjectInfoCache,
  seedObjectInfoCache,
} from '../../../src/services/workflow/objectInfo.js';
import {
  filterProxySettingsByBoundKeys,
} from '../../../src/services/workflow/filterFormBoundProxies.js';
import {
  resolveProxyBoundKeys,
} from '../../../src/services/workflow/proxyLabels.js';
import {
  applyBoundFormInputs,
} from '../../../src/services/workflow/prompt/inject.js';
import { flattenWorkflow } from '../../../src/services/workflow/flatten/index.js';
import type { RawTemplate } from '../../../src/services/templates/types.js';
import type {
  AdvancedSetting, ApiPromptEntry,
} from '../../../src/contracts/workflow.contract.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.resolve(HERE, '../../fixtures/workflows');

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(FIX, rel), 'utf8'));
}

function bareTemplate(name: string): RawTemplate {
  return {
    name, title: name, description: '', mediaType: 'image',
    tags: [], models: [],
  };
}

const objectInfo = readJson('shared.objectInfo.json') as Record<string, Record<string, unknown>>;

beforeAll(() => {
  resetObjectInfoCache();
  seedObjectInfoCache(objectInfo);
});

describe('formFieldPlan invariants — every fixture', () => {
  const fixtures = [
    'templates-image_to_real',
    'image_qwen_image_edit_2509',
    'flux_dev_checkpoint_example',
    'sdxl_simple_example',
  ] as const;

  for (const name of fixtures) {
    it(`${name}: every field has unique id and unique (bindNodeId, bindWidgetName)`, () => {
      const wf = readJson(`${name}.workflow.json`);
      const plan = buildFormFieldPlan(bareTemplate(name), wf, objectInfo);
      const ids = new Set<string>();
      const binds = new Set<string>();
      for (const f of plan.fields) {
        expect(ids.has(f.id), `duplicate id ${f.id} in ${name}`).toBe(false);
        ids.add(f.id);
        if (f.bindNodeId && f.bindWidgetName) {
          const k = `${f.bindNodeId}|${f.bindWidgetName}`;
          expect(binds.has(k), `duplicate bind ${k} in ${name}`).toBe(false);
          binds.add(k);
        }
      }
    });

    it(`${name}: claimSet contains exactly the bound fields`, () => {
      const wf = readJson(`${name}.workflow.json`);
      const plan = buildFormFieldPlan(bareTemplate(name), wf, objectInfo);
      const expected = plan.fields
        .filter(f => f.bindNodeId && f.bindWidgetName)
        .map(f => `${f.bindNodeId}|${f.bindWidgetName}`)
        .sort();
      const got = Array.from(plan.claimSet).sort();
      expect(got).toEqual(expected);
    });

    it(`${name}: every bindNodeId exists in the flattener's node map`, () => {
      const wf = readJson(`${name}.workflow.json`);
      const flat = flattenWorkflow(wf);
      const plan = buildFormFieldPlan(bareTemplate(name), wf, objectInfo);
      for (const f of plan.fields) {
        if (!f.bindNodeId) continue;
        expect(flat.nodes.has(f.bindNodeId), `${name}: ${f.bindNodeId} missing from flat map`).toBe(true);
      }
    });
  }
});

describe('Bug 1 regression — templates-image_to_real (Advanced dups Main prompt)', () => {
  const wf = readJson('templates-image_to_real.workflow.json');

  it('main form has exactly ONE prompt field', () => {
    const plan = buildFormFieldPlan(bareTemplate('templates-image_to_real'), wf, objectInfo);
    const prompts = plan.fields.filter(f => f.id === 'prompt');
    expect(prompts).toHaveLength(1);
    expect(prompts[0].bindNodeId).toBeDefined();
    expect(prompts[0].bindWidgetName).toBe('prompt');
  });

  it('claim set covers the prompt with the SAME compound id the wrapper resolves to', () => {
    const plan = buildFormFieldPlan(bareTemplate('templates-image_to_real'), wf, objectInfo);
    const wrapper = (wf.nodes as Array<Record<string, unknown>>).find(n => {
      const props = n.properties as Record<string, unknown> | undefined;
      return Array.isArray(props?.proxyWidgets);
    });
    expect(wrapper).toBeDefined();
    const proxyWidgets = (wrapper!.properties as Record<string, unknown>)
      .proxyWidgets as string[][];
    const resolved = resolveProxyBoundKeys(wrapper!, proxyWidgets, wf);
    const promptProxyResolved = resolved.find(r => r.widgetName === 'prompt' || r.widgetName === 'text');
    expect(promptProxyResolved).toBeDefined();
    // The claim set's bound key must match (or compound-id equal) what the
    // proxy resolver produced — that's how filterProxySettingsByBoundKeys
    // drops the proxy from Advanced.
    const matched = Array.from(plan.claimSet).some(k => {
      const [nodeId, _w] = k.split('|');
      void _w;
      return nodeId === promptProxyResolved!.nodeId;
    });
    expect(matched).toBe(true);
  });

  it('Advanced filter drops the Prompt proxy entry', () => {
    const plan = buildFormFieldPlan(bareTemplate('templates-image_to_real'), wf, objectInfo);
    const wrapper = (wf.nodes as Array<Record<string, unknown>>).find(n => {
      const props = n.properties as Record<string, unknown> | undefined;
      return Array.isArray(props?.proxyWidgets);
    })!;
    const proxyWidgets = (wrapper.properties as Record<string, unknown>)
      .proxyWidgets as string[][];
    const resolvedKeys = resolveProxyBoundKeys(wrapper, proxyWidgets, wf);
    // Synthetic AdvancedSetting per proxy entry — content doesn't matter for
    // the filter, only proxyIndex does.
    const settings: AdvancedSetting[] = proxyWidgets.map((entry, i) => ({
      id: entry[1], label: entry[1], type: 'text', value: '', proxyIndex: i,
    }));
    const filtered = filterProxySettingsByBoundKeys(
      settings, proxyWidgets, plan.claimSet, resolvedKeys,
    );
    // Whichever proxy index pointed at the prompt should be GONE.
    const promptProxyIdx = resolvedKeys.findIndex(
      r => r.widgetName === 'prompt' || r.widgetName === 'text',
    );
    expect(promptProxyIdx).toBeGreaterThanOrEqual(0);
    expect(filtered.some(s => s.proxyIndex === promptProxyIdx)).toBe(false);
  });
});

describe('Bug 2 regression — image_qwen_image_edit_2509 (twin samplers + 2x Prompt)', () => {
  const wf = readJson('image_qwen_image_edit_2509.workflow.json');

  it('main form has exactly ONE field with id="prompt"', () => {
    const plan = buildFormFieldPlan(bareTemplate('image_qwen_image_edit_2509'), wf, objectInfo);
    const verbatimPrompts = plan.fields.filter(f => f.id === 'prompt');
    expect(verbatimPrompts).toHaveLength(1);
  });

  it('twin-sampler Primitive collisions disambiguate via id suffix', () => {
    const plan = buildFormFieldPlan(bareTemplate('image_qwen_image_edit_2509'), wf, objectInfo);
    // The workflow has duplicated sampler-knob Primitives ("Stpes", "CFG",
    // "Enable Lightning LoRA"). Each pair must produce two DISTINCT ids.
    const labelGroups = new Map<string, Array<{ id: string; bind: string }>>();
    for (const f of plan.fields) {
      if (!f.bindNodeId || f.bindWidgetName !== 'value') continue;
      const list = labelGroups.get(f.label) ?? [];
      list.push({ id: f.id, bind: `${f.bindNodeId}|${f.bindWidgetName}` });
      labelGroups.set(f.label, list);
    }
    for (const [label, list] of labelGroups) {
      if (list.length < 2) continue;
      const uniqueIds = new Set(list.map(x => x.id));
      expect(uniqueIds.size, `label "${label}" should yield distinct ids per bind`).toBe(list.length);
    }
  });
});

describe('Submit path — applyBoundFormInputs writes user values to the right widget', () => {
  it('twin-sampler Primitives receive independent user values', () => {
    const wf = readJson('image_qwen_image_edit_2509.workflow.json');
    const plan = buildFormFieldPlan(bareTemplate('image_qwen_image_edit_2509'), wf, objectInfo);

    // Pick two fields that share a label (the disambiguated-id pair).
    const byLabel = new Map<string, typeof plan.fields>();
    for (const f of plan.fields) {
      const list = byLabel.get(f.label) ?? [];
      list.push(f);
      byLabel.set(f.label, list);
    }
    const collidedPair = [...byLabel.values()].find(list => list.length >= 2 && list[0].bindNodeId);
    expect(collidedPair).toBeDefined();
    const [a, b] = collidedPair!;

    // Build a synthetic API prompt with entries for both bind targets.
    const prompt: Record<string, ApiPromptEntry> = {
      [a.bindNodeId!]: { class_type: 'PrimitiveInt', inputs: { value: 0 }, _meta: { title: 'a' } },
      [b.bindNodeId!]: { class_type: 'PrimitiveInt', inputs: { value: 0 }, _meta: { title: 'b' } },
    };
    const flat = flattenWorkflow(wf);
    applyBoundFormInputs(prompt, flat.nodes, [
      { bindNodeId: a.bindNodeId!, bindWidgetName: a.bindWidgetName!, value: 11 },
      { bindNodeId: b.bindNodeId!, bindWidgetName: b.bindWidgetName!, value: 22 },
    ]);
    expect(prompt[a.bindNodeId!].inputs[a.bindWidgetName!]).toBe(11);
    expect(prompt[b.bindNodeId!].inputs[b.bindWidgetName!]).toBe(22);
  });
});
