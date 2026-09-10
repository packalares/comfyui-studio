import { describe, expect, it } from 'vitest';
import { scrubDeletedRefs } from '../../src/services/workflow/prompt/inject.js';
import type { ApiPrompt } from '../../src/services/workflow/prompt/types.js';

function prompt(entries: Record<string, { class_type: string; inputs: Record<string, unknown> }>): ApiPrompt {
  return entries as unknown as ApiPrompt;
}

describe('scrubDeletedRefs', () => {
  it('deletes muted nodes and drops optional refs to them', () => {
    const p = prompt({
      '1': { class_type: 'LoadImage', inputs: { image: 'x.png' } },
      '2': { class_type: 'KSampler', inputs: { latent_image: ['1', 0], seed: 5 } },
    });
    const res = scrubDeletedRefs(p, new Set(['1']));

    expect(p['1']).toBeUndefined();
    expect(p['2'].inputs.latent_image).toBeUndefined(); // dropped, not left dangling
    expect(p['2'].inputs.seed).toBe(5); // literals untouched
    expect(res.brokenRequired).toEqual([]);
  });

  it('reconnects a survivor around a muted Reroute to its own source', () => {
    const p = prompt({
      '10': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'm.safetensors' } },
      '11': { class_type: 'Reroute', inputs: { value: ['10', 0] } },
      '12': { class_type: 'KSampler', inputs: { model: ['11', 0] } },
    });
    // Mute only the reroute (10 survives).
    const res = scrubDeletedRefs(p, new Set(['11']));

    expect(p['11']).toBeUndefined();
    // 12.model rewired straight to 10 (the reroute's upstream), slot preserved.
    expect(p['12'].inputs.model).toEqual(['10', 0]);
    expect(res.brokenRequired).toEqual([]);
  });

  it('follows a chain of muted Reroutes to the first surviving source', () => {
    const p = prompt({
      '10': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'm.safetensors' } },
      '11': { class_type: 'Reroute', inputs: { value: ['10', 0] } },
      '12': { class_type: 'Reroute', inputs: { value: ['11', 0] } },
      '13': { class_type: 'KSampler', inputs: { model: ['12', 0] } },
    });
    scrubDeletedRefs(p, new Set(['11', '12']));
    expect(p['13'].inputs.model).toEqual(['10', 0]);
  });

  it('flags a broken REQUIRED input that cannot be reconnected', () => {
    const p = prompt({
      '20': { class_type: 'CLIPTextEncode', inputs: { text: 'hi', clip: ['99', 0] } },
      '21': { class_type: 'KSampler', inputs: { positive: ['20', 0] } },
    });
    // 'text' is required on CLIPTextEncode; 'positive' is required on KSampler.
    const isOptional = (ct: string, key: string): boolean => {
      const required: Record<string, string[]> = {
        CLIPTextEncode: ['text', 'clip'],
        KSampler: ['positive'],
      };
      return !(required[ct] ?? []).includes(key);
    };
    const res = scrubDeletedRefs(p, new Set(['20']), isOptional);

    expect(p['20']).toBeUndefined();
    expect(p['21'].inputs.positive).toBeUndefined(); // still dropped for a clean error
    expect(res.brokenRequired).toEqual([
      { nodeId: '21', input: 'positive', wasFedBy: '20' },
    ]);
  });

  it('treats dynamic/undeclared inputs as optional (no false broken-required)', () => {
    const p = prompt({
      '30': { class_type: 'VAEDecode', inputs: {} },
      '31': { class_type: 'ImpactSwitch', inputs: { input1: ['30', 0], select: 1 } },
    });
    // ImpactSwitch declares no `input1` in required → optional gap.
    const isOptional = (ct: string, key: string): boolean =>
      !(ct === 'ImpactSwitch' && key === 'select');
    const res = scrubDeletedRefs(p, new Set(['30']), isOptional);

    expect(p['31'].inputs.input1).toBeUndefined();
    expect(res.brokenRequired).toEqual([]);
  });

  it('handles subgraph-qualified compound ids', () => {
    const p = prompt({
      '340:332': { class_type: 'LoadImage', inputs: { image: 'y.png' } },
      '400': { class_type: 'KSampler', inputs: { latent_image: ['340:332', 0] } },
    });
    scrubDeletedRefs(p, new Set(['340:332']));
    expect(p['340:332']).toBeUndefined();
    expect(p['400'].inputs.latent_image).toBeUndefined();
  });
});
