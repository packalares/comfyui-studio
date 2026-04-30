// Unit tests for the proxy-setting dedup filter used by
// /api/workflow-settings/:templateName. The filter drops Advanced-Settings
// proxy entries whose (innerNodeId, widgetName) is already claimed by a
// bound main-form field — fixes the LTX-2.3 i2v double-prompt bug where the
// PrimitiveStringMultiline that backs the main Prompt also appeared in
// Advanced Settings.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it, beforeAll } from 'vitest';
import type { AdvancedSetting } from '../../src/contracts/workflow.contract.js';
import {
  computeFormBoundKeys,
  filterProxySettingsByBoundKeys,
} from '../../src/services/workflow/filterFormBoundProxies.js';
import {
  extractAdvancedSettings,
  findSubgraphDef,
  resolveProxyBoundKeys,
  resolveProxyLabels,
} from '../../src/services/workflow/proxyLabels.js';
import {
  resetObjectInfoCache,
  seedObjectInfoCache,
} from '../../src/services/workflow/objectInfo.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, '..', 'fixtures', 'workflows');

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(FIX, rel), 'utf8'));
}

function findWrapper(wf: Record<string, unknown>): {
  wrapper: Record<string, unknown>;
  proxyWidgets: string[][];
  widgetValues: unknown[];
} {
  const nodes = wf.nodes as Array<Record<string, unknown>>;
  for (const n of nodes) {
    const props = n.properties as Record<string, unknown> | undefined;
    if (props?.proxyWidgets && Array.isArray(props.proxyWidgets)) {
      return {
        wrapper: n,
        proxyWidgets: props.proxyWidgets as string[][],
        widgetValues: (n.widgets_values || []) as unknown[],
      };
    }
  }
  throw new Error('no wrapper node with proxyWidgets');
}

function mkSetting(id: string, proxyIndex: number): AdvancedSetting {
  return { id, label: id, type: 'text', value: '', proxyIndex };
}

describe('filterProxySettingsByBoundKeys', () => {
  it('dedupes proxy entries that match bound form fields', () => {
    // Mirrors LTX-2.3 i2v: proxy[0] is the PrimitiveStringMultiline at node
    // 266 (main prompt), proxy[1] is a seed widget (untouched).
    const proxyWidgets = [
      ['266', 'value'],
      ['237', 'noise_seed'],
    ];
    const settings = [mkSetting('value', 0), mkSetting('noise_seed', 1)];
    const bound = new Set(['266|value']);
    const out = filterProxySettingsByBoundKeys(settings, proxyWidgets, bound);
    expect(out).toHaveLength(1);
    expect(out[0].proxyIndex).toBe(1);
    expect(out[0].id).toBe('noise_seed');
  });

  it('leaves non-form-bound proxy entries alone', () => {
    const proxyWidgets = [
      ['237', 'noise_seed'],
      ['232', 'lora_name'],
    ];
    const settings = [mkSetting('noise_seed', 0), mkSetting('lora_name', 1)];
    // Main form has bindings that don't match ANY proxy entry.
    const bound = new Set(['300|text', '301|tags']);
    const out = filterProxySettingsByBoundKeys(settings, proxyWidgets, bound);
    expect(out).toHaveLength(2);
    expect(out.map(s => s.proxyIndex)).toEqual([0, 1]);
  });

  it('preserves raw-widget sentinel entries regardless of bound set', () => {
    // Raw-widget settings carry proxyIndex: -1 and are deduped elsewhere
    // via formClaimed. They must survive this pass unchanged.
    const proxyWidgets = [['266', 'value']];
    const settings: AdvancedSetting[] = [
      { id: 'raw', label: 'raw', type: 'text', value: '', proxyIndex: -1 },
    ];
    const bound = new Set(['266|value']);
    const out = filterProxySettingsByBoundKeys(settings, proxyWidgets, bound);
    expect(out).toHaveLength(1);
    expect(out[0].proxyIndex).toBe(-1);
  });

  it('drops only the matching entry when multiple proxies share a node id', () => {
    const proxyWidgets = [
      ['237', 'noise_seed'],
      ['237', 'control_after_generate'],
    ];
    const settings = [
      mkSetting('noise_seed', 0),
      mkSetting('control_after_generate', 1),
    ];
    const bound = new Set(['237|noise_seed']);
    const out = filterProxySettingsByBoundKeys(settings, proxyWidgets, bound);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('control_after_generate');
  });
});

describe('filterProxySettingsByBoundKeys — LTX-2.3 i2v fixture', () => {
  beforeAll(() => {
    resetObjectInfoCache();
    seedObjectInfoCache(
      readJson('ltx2_i2v.objectInfo.json') as Record<string, Record<string, unknown>>,
    );
  });

  // Integration check: load the real workflow, extract all proxy entries,
  // compute the main-form bound keys, and verify the PrimitiveStringMultiline
  // proxy at node 266 (the main Prompt) is removed — exact bug from the task
  // brief. The template also ships titled PrimitiveInt/Float nodes (Width,
  // Height, Length, Frame Rate, Steps) that become bound form fields; those
  // proxies drop too. Non-form-bound proxies (seeds, model names, lora names)
  // survive.
  it('drops proxy entries that are bound in the main form, preserves the rest', () => {
    const wf = readJson('ltx2_i2v.workflow.json');
    const { wrapper, proxyWidgets, widgetValues } = findWrapper(wf);
    const objectInfo = readJson('ltx2_i2v.objectInfo.json') as Record<string, Record<string, unknown>>;
    const labels = resolveProxyLabels(wrapper, proxyWidgets, wf);
    const sg = findSubgraphDef(wrapper, wf);
    const sgNodes = (sg?.nodes || []) as Array<Record<string, unknown>>;
    const settings = extractAdvancedSettings(proxyWidgets, widgetValues, objectInfo, labels, sgNodes);
    expect(settings).toHaveLength(13);

    const bound = computeFormBoundKeys('video_ltx2_3_i2v', wf, objectInfo);
    // Compound-id world: the LTX2 prompt Primitive lives inside wrapper 267,
    // so its bind key is `267:266|value`. This is the exact field the bug
    // reported as duplicated.
    expect(bound.has('267:266|value')).toBe(true);

    // Plan-derived claim sets carry compound ids; the proxy filter relies on
    // resolveProxyBoundKeys to translate the wrapper's bare proxy entries
    // into the same compound-id space before matching.
    const resolvedKeys = resolveProxyBoundKeys(wrapper, proxyWidgets, wf);
    const filtered = filterProxySettingsByBoundKeys(
      settings, proxyWidgets, bound, resolvedKeys,
    );
    // Every surviving entry's compound key must NOT appear in bound.
    for (const s of filtered) {
      const r = resolvedKeys[s.proxyIndex];
      expect(bound.has(`${r.nodeId}|${r.widgetName}`)).toBe(false);
    }
    // Dropped set = proxies whose compound key is in bound.
    const dropped = settings.filter(s => !filtered.includes(s));
    for (const s of dropped) {
      const r = resolvedKeys[s.proxyIndex];
      expect(bound.has(`${r.nodeId}|${r.widgetName}`)).toBe(true);
    }
    // Crucial assertion: the main-prompt proxy IS in the dropped set.
    expect(
      dropped.some(s => {
        const [id, w] = proxyWidgets[s.proxyIndex];
        return id === '266' && w === 'value';
      }),
    ).toBe(true);
    // And non-primitive proxies (e.g. the noise_seed on node 237) survive.
    expect(
      filtered.some(s => {
        const [id, w] = proxyWidgets[s.proxyIndex];
        return id === '237' && w === 'noise_seed';
      }),
    ).toBe(true);
  });
});
