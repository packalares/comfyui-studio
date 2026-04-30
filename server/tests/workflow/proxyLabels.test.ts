// Proxy-label resolution tests.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import {
  extractAdvancedSettings,
  findSubgraphDef,
  resolveProxyLabels,
} from '../../src/services/workflow/proxyLabels.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, '..', 'fixtures', 'workflows');

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(FIX, rel), 'utf8'));
}

describe('resolveProxyLabels', () => {
  it('follows a subgraph -10 link to the real target node title', () => {
    // Proxy entry with innerNodeId "-1" points via subgraph input "control"
    // through a -10 link at slot 0 to an inner KSampler node.
    const workflow = {
      definitions: {
        subgraphs: [
          {
            id: 'my_wrapper_type',
            nodes: [
              { id: 40, type: 'KSampler', title: 'Main Sampler', inputs: [
                { name: 'seed', link: 99, widget: { name: 'seed' } },
              ] },
            ],
            links: [
              { id: 99, origin_id: -10, origin_slot: 0, target_id: 40, target_slot: 0 },
            ],
            inputs: [{ name: 'control' }],
          },
        ],
      },
    };
    const wrapperNode = { type: 'my_wrapper_type', inputs: [], outputs: [] };
    const proxyWidgets = [['-1', 'control']];
    const labels = resolveProxyLabels(wrapperNode, proxyWidgets, workflow);
    // Should resolve to "Main Sampler · Seed" (node title + resolved
    // internal input name, title-cased).
    expect(labels[0]).toMatch(/Main Sampler.*Seed/);
  });

  it('uses an explicit subgraph input label when present', () => {
    const workflow = {
      definitions: {
        subgraphs: [
          {
            id: 'sg',
            nodes: [],
            links: [],
            inputs: [{ name: 'steps', label: 'Sampling Steps' }],
          },
        ],
      },
    };
    const wrapperNode = { type: 'sg', inputs: [], outputs: [] };
    const labels = resolveProxyLabels(wrapperNode, [['-1', 'steps']], workflow);
    expect(labels[0]).toBe('Sampling Steps');
  });

  it('uses the direct inner node title when innerNodeId is numeric', () => {
    const workflow = {
      definitions: {
        subgraphs: [
          {
            id: 'sg',
            nodes: [{ id: 3, type: 'Sampler', title: 'Custom Sampler' }],
            links: [],
            inputs: [],
          },
        ],
      },
    };
    const wrapperNode = { type: 'sg', inputs: [], outputs: [] };
    const labels = resolveProxyLabels(wrapperNode, [['3', 'cfg']], workflow);
    expect(labels[0]).toMatch(/Custom Sampler.*Cfg/);
  });
});

describe('extractAdvancedSettings', () => {
  const comboObjectInfo = {
    CheckpointLoaderSimple: {
      input: {
        required: {
          ckpt_name: ['COMBO', { options: ['foo.safetensors', 'bar.safetensors'] }],
        },
      },
    },
  } satisfies Record<string, Record<string, unknown>>;

  it('surfaces an author-proxied checkpoint name as a select when objectInfo has options', () => {
    const sgNodes = [
      { id: 10, type: 'CheckpointLoaderSimple', widgets_values: ['foo.safetensors'] },
    ] as Array<Record<string, unknown>>;
    const settings = extractAdvancedSettings(
      [['10', 'ckpt_name']],
      [],
      comboObjectInfo,
      ['Checkpoint'],
      sgNodes,
    );
    expect(settings).toHaveLength(1);
    expect(settings[0].value).toBe('foo.safetensors');
    expect(settings[0].type).toBe('select');
    expect(settings[0].options?.map(o => o.value))
      .toEqual(['foo.safetensors', 'bar.safetensors']);
  });

  it('renders a proxied combo as text when objectInfo lacks options (defensive)', () => {
    const sgNodes = [
      { id: 10, type: 'CheckpointLoaderSimple', widgets_values: ['foo.safetensors'] },
    ] as Array<Record<string, unknown>>;
    const objectInfoNoOptions = {
      CheckpointLoaderSimple: {
        input: { required: { ckpt_name: ['COMBO', {}] } },
      },
    } satisfies Record<string, Record<string, unknown>>;
    const settings = extractAdvancedSettings(
      [['10', 'ckpt_name']],
      [],
      objectInfoNoOptions,
      ['Checkpoint'],
      sgNodes,
    );
    // Type degrades to 'text' and the empty options list is not surfaced.
    expect(settings[0].type).toBe('text');
    expect(settings[0].options).toBeUndefined();
    expect(settings[0].value).toBe('foo.safetensors');
  });

  it('keeps noise_seed as a seed setting via KNOWN_SETTINGS (regression)', () => {
    const sgNodes = [
      { id: 237, type: 'RandomNoise', widgets_values: [42, 'randomize'] },
    ] as Array<Record<string, unknown>>;
    const objectInfo = {
      RandomNoise: {
        input: { required: { noise_seed: ['INT', { min: 0 }] } },
      },
    } satisfies Record<string, Record<string, unknown>>;
    const settings = extractAdvancedSettings(
      [['237', 'noise_seed']],
      [],
      objectInfo,
      ['Noise Seed'],
      sgNodes,
    );
    expect(settings[0].type).toBe('seed');
    expect(settings[0].value).toBe(42);
  });

  it('reads values off inner nodes when the wrapper widgets_values is empty', () => {
    const sgNodes = [
      { id: 257, type: 'PrimitiveInt', widgets_values: [1280, 'fixed'] },
    ] as Array<Record<string, unknown>>;
    const objectInfo = {
      PrimitiveInt: {
        input: { required: { value: ['INT', { min: 0, max: 4096 }] } },
      },
    } satisfies Record<string, Record<string, unknown>>;
    const settings = extractAdvancedSettings(
      [['257', 'value']],
      [], // wrapper widgets_values is empty on modern subgraph format
      objectInfo,
      ['Width'],
      sgNodes,
    );
    expect(settings[0].value).toBe(1280);
    expect(settings[0].type).toBe('number');
  });

  it('threads wrapperNodeId / wrapperNodeTitle onto every emitted setting', () => {
    // The Advanced Settings UI groups by nodeId; for proxy templates every
    // proxied widget originates from the same wrapper, so they share an
    // attribution.
    const sgNodes = [
      { id: 257, type: 'PrimitiveInt', widgets_values: [1280] },
    ] as Array<Record<string, unknown>>;
    const objectInfo = {
      PrimitiveInt: { input: { required: { value: ['INT', {}] } } },
    } satisfies Record<string, Record<string, unknown>>;
    const settings = extractAdvancedSettings(
      [['257', 'value']], [], objectInfo, ['Width'], sgNodes,
      undefined, undefined, undefined,
      '267', 'Video Generation (LTX-2.3)',
    );
    expect(settings[0].nodeId).toBe('267');
    expect(settings[0].nodeTitle).toBe('Video Generation (LTX-2.3)');
  });

  it('leaves nodeId / nodeTitle undefined when wrapper attribution is omitted', () => {
    const sgNodes = [
      { id: 10, type: 'CheckpointLoaderSimple', widgets_values: ['foo.safetensors'] },
    ] as Array<Record<string, unknown>>;
    const settings = extractAdvancedSettings(
      [['10', 'ckpt_name']], [], comboObjectInfo, ['Checkpoint'], sgNodes,
    );
    expect(settings[0].nodeId).toBeUndefined();
    expect(settings[0].nodeTitle).toBeUndefined();
  });

  it('treats PrimitiveStringMultiline as textarea with the inner node value', () => {
    const sgNodes = [
      { id: 266, type: 'PrimitiveStringMultiline', widgets_values: ['test prompt'] },
    ] as Array<Record<string, unknown>>;
    const objectInfo = {
      PrimitiveStringMultiline: {
        input: { required: { value: ['STRING', { multiline: true }] } },
      },
    } satisfies Record<string, Record<string, unknown>>;
    const settings = extractAdvancedSettings(
      [['266', 'value']],
      [],
      objectInfo,
      ['Prompt'],
      sgNodes,
    );
    expect(settings[0].value).toBe('test prompt');
    expect(settings[0].type).toBe('textarea');
  });

  it('end-to-end: the 13 author-proxied widgets on video_ltx2_3_i2v surface with live values', () => {
    const wf = readJson('ltx2_i2v.workflow.json');
    const objectInfo = readJson('ltx2_i2v.objectInfo.json') as Record<string, Record<string, unknown>>;

    const topNodes = (wf.nodes || []) as Array<Record<string, unknown>>;
    const wrapper = topNodes.find(n => {
      const props = n.properties as Record<string, unknown> | undefined;
      return props?.proxyWidgets && Array.isArray(props.proxyWidgets);
    });
    expect(wrapper).toBeTruthy();
    const proxyWidgets = (wrapper!.properties as Record<string, unknown>).proxyWidgets as string[][];
    expect(proxyWidgets).toHaveLength(13);

    const sg = findSubgraphDef(wrapper!, wf);
    const sgNodes = (sg?.nodes || []) as Array<Record<string, unknown>>;
    const labels = resolveProxyLabels(wrapper!, proxyWidgets, wf);
    const wrapperValues = (wrapper!.widgets_values || []) as unknown[];
    const settings = extractAdvancedSettings(
      proxyWidgets, wrapperValues, objectInfo, labels, sgNodes,
    );

    expect(settings).toHaveLength(13);

    // noise_seed must never surface null — its value lives on inner node 237.
    const noiseSeed = settings.find(s => s.id === 'noise_seed');
    expect(noiseSeed).toBeTruthy();
    expect(noiseSeed!.value).not.toBeNull();
    expect(noiseSeed!.type).toBe('seed');

    // At least 10 of 13 must carry a live value (the remaining <=3 are the
    // author's control-only / primitive-boolean entries where null-like
    // values are acceptable).
    const nonNull = settings.filter(s => s.value !== null && s.value !== undefined);
    expect(nonNull.length).toBeGreaterThanOrEqual(10);
  });
});
