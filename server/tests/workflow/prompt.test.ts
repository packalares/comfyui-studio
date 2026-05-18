// workflowToApiPrompt tests — cover the prompt-injection, seed-
// randomisation and filteredWidgetValues behaviours we must not regress.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { seedObjectInfoCache, resetObjectInfoCache } from '../../src/services/workflow/objectInfo.js';
import { workflowToApiPrompt } from '../../src/services/workflow/prompt/index.js';

// Spec shorthand helpers.
const STR_MULTI = ['STRING', { multiline: true }] as const;
const STR_SINGLE = ['STRING', {}] as const;

describe('workflowToApiPrompt', () => {
  beforeEach(() => {
    resetObjectInfoCache();
  });

  it('writes the user prompt to the positive CLIPTextEncode only', async () => {
    seedObjectInfoCache({
      CLIPTextEncode: {
        input: { required: { text: STR_MULTI, clip: ['CLIP'] } },
        output: ['CONDITIONING'],
      },
    });
    const wf = {
      nodes: [
        {
          id: 10, type: 'CLIPTextEncode', title: 'Positive Prompt',
          inputs: [], widgets_values: ['placeholder-pos'],
        },
        {
          id: 11, type: 'CLIPTextEncode', title: 'Negative Prompt',
          inputs: [], widgets_values: ['placeholder-neg'],
        },
      ],
      links: [],
    };
    const out = await workflowToApiPrompt(wf, { prompt: 'HELLO WORLD' }, []);
    expect(out['10'].inputs.text).toBe('HELLO WORLD');
    // Negative kept its placeholder.
    expect(out['11'].inputs.text).toBe('placeholder-neg');
  });

  it('writes to both clip_l and t5xxl on a CLIPTextEncodeFlux node', async () => {
    seedObjectInfoCache({
      CLIPTextEncodeFlux: {
        input: {
          required: {
            clip_l: STR_MULTI,
            t5xxl: STR_MULTI,
            guidance: ['FLOAT', { min: 0, max: 10 }],
            clip: ['CLIP'],
          },
        },
        output: ['CONDITIONING'],
      },
    });
    const wf = {
      nodes: [
        {
          id: 5, type: 'CLIPTextEncodeFlux', title: 'Prompt',
          inputs: [], widgets_values: ['ph-l', 'ph-t', 3.5],
        },
      ],
      links: [],
    };
    const out = await workflowToApiPrompt(wf, { prompt: 'a fox jumping' }, []);
    expect(out['5'].inputs.clip_l).toBe('a fox jumping');
    expect(out['5'].inputs.t5xxl).toBe('a fox jumping');
    // guidance is untouched (not a multiline STRING).
    expect(out['5'].inputs.guidance).toBe(3.5);
  });

  it('falls back to the first multiline STRING widget on audio-style nodes', async () => {
    seedObjectInfoCache({
      TextEncodeAceStepAudio: {
        input: { required: { tags: STR_MULTI, model: ['MODEL'] } },
        output: ['CONDITIONING'],
      },
    });
    const wf = {
      nodes: [
        {
          id: 7, type: 'TextEncodeAceStepAudio', title: 'Lyrics',
          inputs: [], widgets_values: ['old-tags'],
        },
      ],
      links: [],
    };
    const out = await workflowToApiPrompt(wf, { prompt: 'lofi jazz' }, []);
    expect(out['7'].inputs.tags).toBe('lofi jazz');
  });

  it('randomises seed for KSampler', async () => {
    // We don't care about the exact random value, just that it changes
    // between runs and lands on the seed key.
    seedObjectInfoCache({
      KSampler: {
        input: {
          required: {
            seed: ['INT', { min: 0, max: 2 ** 31 - 1 }],
            steps: ['INT', { min: 1 }],
            cfg: ['FLOAT', {}],
            sampler_name: [['euler', 'heun']],
            scheduler: [['normal', 'karras']],
            denoise: ['FLOAT', { min: 0, max: 1 }],
            model: ['MODEL'],
            positive: ['CONDITIONING'],
            negative: ['CONDITIONING'],
            latent_image: ['LATENT'],
          },
        },
        output: ['LATENT'],
      },
    });
    const wf = {
      nodes: [
        {
          id: 3, type: 'KSampler', inputs: [],
          // seed=42, 'randomize' will be filtered, rest aligned.
          widgets_values: [42, 'randomize', 20, 7.5, 'euler', 'normal', 1.0],
        },
      ],
      links: [],
    };
    const randSpy = vi.spyOn(Math, 'random').mockReturnValueOnce(0.5);
    const out = await workflowToApiPrompt(wf, {}, []);
    randSpy.mockRestore();
    // New seed should replace 42 after randomisation.
    expect(out['3'].inputs.seed).not.toBe(42);
    expect(typeof out['3'].inputs.seed).toBe('number');
    // And other widgets should have aligned correctly despite the
    // 'randomize' token — steps should be 20, not 'randomize'.
    expect(out['3'].inputs.steps).toBe(20);
    expect(out['3'].inputs.cfg).toBe(7.5);
  });

  it('randomises noise_seed for RandomNoise', async () => {
    seedObjectInfoCache({
      RandomNoise: {
        input: { required: { noise_seed: ['INT', { min: 0 }] } },
        output: ['NOISE'],
      },
    });
    const wf = {
      nodes: [
        {
          id: 4, type: 'RandomNoise', inputs: [],
          widgets_values: [0, 'randomize'],
        },
      ],
      links: [],
    };
    const out = await workflowToApiPrompt(wf, {}, []);
    expect(typeof out['4'].inputs.noise_seed).toBe('number');
    // Seed is sampled from [0, 2^31); guard against it always being zero.
    const rolls = [];
    for (let i = 0; i < 5; i++) {
      const r = await workflowToApiPrompt(wf, {}, []);
      rolls.push(r['4'].inputs.noise_seed);
    }
    expect(new Set(rolls).size).toBeGreaterThan(1);
  });

  it('drops dangling OPTIONAL input wires that point at a bypassed (removed) source', async () => {
    // Regression for 02_qwen_Image_edit_subgraphed: bypassed LoadImage feeds
    // an optional image2 slot. The flatten dropped the bypassed node from
    // the prompt; without the dangling-ref guard, the encoder kept an
    // input wire to the missing id and ComfyUI's validator threw "node
    // not found". With the guard, optional inputs whose source is gone
    // disappear and ComfyUI falls back to the default — required inputs
    // are unchanged so genuinely-broken workflows still error.
    seedObjectInfoCache({
      TextEncodeQwenImageEditPlus: {
        input: {
          required: { clip: ['CLIP'], prompt: STR_MULTI },
          optional: { image2: ['IMAGE'] },
        },
        output: ['CONDITIONING'],
      },
      LoadImage: {
        input: { required: { image: ['STRING', { image_upload: true }] } },
        output: ['IMAGE', 'MASK'],
      },
      CLIPLoader: {
        input: { required: { clip_name: ['STRING', {}] } },
        output: ['CLIP'],
      },
    });
    const wf = {
      nodes: [
        { id: 1, type: 'CLIPLoader', inputs: [], widgets_values: ['t.safetensors'] },
        { id: 2, type: 'LoadImage', mode: 4, inputs: [], widgets_values: ['bypassed.png'] },
        {
          id: 3, type: 'TextEncodeQwenImageEditPlus',
          inputs: [
            { name: 'clip', type: 'CLIP', link: 100 },
            { name: 'image2', type: 'IMAGE', link: 101 },
          ],
          widgets_values: ['hello'],
        },
      ],
      links: [
        [100, 1, 0, 3, 0, 'CLIP'],
        [101, 2, 0, 3, 1, 'IMAGE'],
      ],
    };
    const out = await workflowToApiPrompt(wf, {}, []);
    // Bypassed LoadImage stays out of the prompt.
    expect(out['2']).toBeUndefined();
    // The encoder kept its valid `clip` ref + its `prompt` widget, but the
    // dangling `image2` wire to bypassed node 2 was dropped.
    expect(out['3'].inputs.clip).toEqual(['1', 0]);
    expect(out['3'].inputs.prompt).toBe('hello');
    expect(out['3'].inputs.image2).toBeUndefined();
  });

  it('terminal bypass with no inputs drops the consumer wire (clear error from ComfyUI)', async () => {
    // Bypassed LoadImage has no upstream inputs to passthrough. followBypassed
    // returns null, resolveInput returns null, and the consumer's input is
    // dropped from the API prompt. ComfyUI then surfaces "required input
    // 'images' missing" — clearer than the previous "node '1' not found"
    // dangling-ref error, and matches ComfyUI Web's own bypass behaviour.
    seedObjectInfoCache({
      SaveImage: {
        input: { required: { images: ['IMAGE'], filename_prefix: ['STRING', {}] } },
        output: [],
      },
      LoadImage: {
        input: { required: { image: ['STRING', { image_upload: true }] } },
        output: ['IMAGE', 'MASK'],
      },
    });
    const wf = {
      nodes: [
        { id: 1, type: 'LoadImage', mode: 4, inputs: [], widgets_values: ['x.png'] },
        {
          id: 2, type: 'SaveImage',
          inputs: [{ name: 'images', type: 'IMAGE', link: 50 }],
          widgets_values: ['out'],
        },
      ],
      links: [[50, 1, 0, 2, 0, 'IMAGE']],
    };
    const out = await workflowToApiPrompt(wf, {}, []);
    // Bypassed terminal node is not emitted.
    expect(out['1']).toBeUndefined();
    // Consumer's wire is dropped (ComfyUI surfaces a clear required-missing error).
    expect(out['2'].inputs.images).toBeUndefined();
  });

  it('rewires mid-chain bypass via followBypassed (SeedVR2 JoinImageWithAlpha pattern)', async () => {
    // The bug: SeedVR2 templates ship with JoinImageWithAlpha bypassed
    // between LoadImage and the upscaler. Previously scope.ts dropped the
    // bypassed node from ctx.nodes entirely, so resolveInput fell back to
    // a dangling [bypassed_id, slot] ref and ComfyUI's validator threw
    // `KeyError: '<bypassed_id>'`. With bypassed nodes kept in ctx.nodes,
    // followBypassed walks through the type-matched input and the consumer
    // gets the real upstream ref — same passthrough behaviour as ComfyUI
    // Web's own bypass.
    seedObjectInfoCache({
      LoadImage: {
        input: { required: { image: ['STRING', { image_upload: true }] } },
        output: ['IMAGE', 'MASK'],
      },
      JoinImageWithAlpha: {
        input: { required: { image: ['IMAGE'], alpha: ['MASK'] } },
        output: ['IMAGE'],
      },
      SaveImage: {
        input: { required: { images: ['IMAGE'], filename_prefix: ['STRING', {}] } },
        output: [],
      },
    });
    const wf = {
      nodes: [
        { id: 1, type: 'LoadImage', inputs: [], widgets_values: ['src.png'] },
        {
          id: 2, type: 'JoinImageWithAlpha', mode: 4,
          inputs: [
            { name: 'image', type: 'IMAGE', link: 10 },
            { name: 'alpha', type: 'MASK', link: null },
          ],
          widgets_values: [],
        },
        {
          id: 3, type: 'SaveImage',
          inputs: [{ name: 'images', type: 'IMAGE', link: 20 }],
          widgets_values: ['out'],
        },
      ],
      links: [
        [10, 1, 0, 2, 0, 'IMAGE'],
        [20, 2, 0, 3, 0, 'IMAGE'],
      ],
    };
    const out = await workflowToApiPrompt(wf, {}, []);
    // Bypassed node is NOT in the API prompt — ComfyUI never sees it.
    expect(out['2']).toBeUndefined();
    // Consumer's wire is rewritten to the bypassed node's upstream source.
    expect(out['3'].inputs.images).toEqual(['1', 0]);
  });

  it('filteredWidgetValues strips "randomize" before index alignment (integration)', async () => {
    // A second regression pin on the KSampler alignment bug.
    seedObjectInfoCache({
      KSampler: {
        input: {
          required: {
            seed: ['INT', { min: 0 }],
            steps: ['INT', { min: 1 }],
            cfg: ['FLOAT', {}],
            model: ['MODEL'],
          },
        },
        output: ['LATENT'],
      },
    });
    const wf = {
      nodes: [
        {
          id: 8, type: 'KSampler', inputs: [],
          // Simulates UI-format with 'randomize' injected at index 1.
          widgets_values: [99, 'randomize', 30, 8.0],
        },
      ],
      links: [],
    };
    const out = await workflowToApiPrompt(wf, {}, []);
    // KSampler seed is randomized, but steps + cfg must align correctly.
    expect(out['8'].inputs.steps).toBe(30);
    expect(out['8'].inputs.cfg).toBe(8.0);
  });
});
