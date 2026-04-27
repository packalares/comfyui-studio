// Unit tests for the gallery metadata extractor.
//
// Covers:
//  - Back-compat: classic SD KSampler workflow → every legacy field populated.
//  - Modern subgraph video (LTX2): title-based width/height/length/fps,
//    wire-chased prompt, all loader models collected.
//  - Trivial math wires (a/2) resolved as numeric literals.
//  - Duration from ComfyUI history `status.messages` timestamps.
//  - Legacy call signature (apiPrompt only) keeps working.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  extractMetadata,
  randomizeSeeds,
  type ApiPrompt,
} from '../../src/services/gallery.extract.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(HERE, '..', 'fixtures', 'workflows');

describe('extractMetadata', () => {
  it('returns all-null for empty/invalid input', () => {
    const empty = {
      promptText: null, negativeText: null, seed: null, model: null,
      sampler: null, scheduler: null, steps: null, cfg: null, denoise: null,
      width: null, height: null, length: null, fps: null, batchSize: null,
      durationMs: null, models: [],
    };
    expect(extractMetadata(null)).toEqual(empty);
    expect(extractMetadata(undefined)).toEqual(extractMetadata(null));
    expect(extractMetadata({} as ApiPrompt)).toEqual(extractMetadata(null));
  });

  it('extracts full metadata from a canonical SD1.5 workflow', () => {
    const prompt: ApiPrompt = {
      '1': {
        class_type: 'CheckpointLoaderSimple',
        inputs: { ckpt_name: 'sd-v1-5.safetensors' },
      },
      '2': {
        class_type: 'CLIPTextEncode',
        inputs: { text: 'a corgi riding a skateboard', clip: ['1', 1] },
      },
      '3': {
        class_type: 'CLIPTextEncode',
        inputs: { text: 'blurry, ugly', clip: ['1', 1] },
      },
      '4': {
        class_type: 'EmptyLatentImage',
        inputs: { width: 512, height: 768, batch_size: 1 },
      },
      '5': {
        class_type: 'KSampler',
        inputs: {
          seed: 123456789,
          steps: 20,
          cfg: 7.5,
          sampler_name: 'euler',
          scheduler: 'normal',
          denoise: 1.0,
          model: ['1', 0],
          positive: ['2', 0],
          negative: ['3', 0],
          latent_image: ['4', 0],
        },
      },
    };
    const meta = extractMetadata(prompt);
    expect(meta.promptText).toBe('a corgi riding a skateboard');
    expect(meta.negativeText).toBe('blurry, ugly');
    expect(meta.seed).toBe(123456789);
    expect(meta.model).toBe('sd-v1-5.safetensors');
    expect(meta.sampler).toBe('euler');
    expect(meta.steps).toBe(20);
    expect(meta.cfg).toBe(7.5);
    expect(meta.width).toBe(512);
    expect(meta.height).toBe(768);
  });

  it('falls back to longest CLIPTextEncode when there is no KSampler', () => {
    const prompt: ApiPrompt = {
      '1': {
        class_type: 'CLIPTextEncode',
        inputs: { text: 'short' },
      },
      '2': {
        class_type: 'CLIPTextEncode',
        inputs: { text: 'a much longer positive prompt describing the scene' },
      },
    };
    const meta = extractMetadata(prompt);
    expect(meta.promptText).toBe('a much longer positive prompt describing the scene');
    expect(meta.seed).toBeNull();
    expect(meta.sampler).toBeNull();
  });

  it('handles missing CLIPTextEncode entries on the sampler wires', () => {
    // The KSampler references nodes that don't exist / aren't text encoders
    // (e.g. a CLIPTextEncodeSDXL node). Positive text should fall back to
    // the longest text encoder; negative should be null-safe (empty string).
    const prompt: ApiPrompt = {
      '10': {
        class_type: 'SomeCustomPromptNode',
        inputs: { text: 'will not resolve' },
      },
      '11': {
        class_type: 'CLIPTextEncode',
        inputs: { text: 'fallback prompt via longest' },
      },
      '99': {
        class_type: 'KSampler',
        inputs: {
          seed: 42, steps: 10, cfg: 5.0, sampler_name: 'dpm++',
          positive: ['10', 0],
          negative: ['12', 0],
        },
      },
    };
    const meta = extractMetadata(prompt);
    expect(meta.promptText).toBe('fallback prompt via longest');
    expect(meta.negativeText).toBe('');
    expect(meta.seed).toBe(42);
    expect(meta.sampler).toBe('dpm++');
  });

  it('supports KSamplerAdvanced noise_seed and UNETLoader fallback', () => {
    const prompt: ApiPrompt = {
      '1': {
        class_type: 'UNETLoader',
        inputs: { unet_name: 'flux-dev.safetensors' },
      },
      '2': {
        class_type: 'KSamplerAdvanced',
        inputs: {
          noise_seed: 77,
          steps: 4,
          cfg: 1.0,
          sampler_name: 'euler_ancestral',
        },
      },
    };
    const meta = extractMetadata(prompt);
    expect(meta.seed).toBe(77);
    expect(meta.model).toBe('flux-dev.safetensors');
    expect(meta.steps).toBe(4);
  });

  it('reads `tags` as promptText from TextEncodeAceStepAudio', () => {
    const prompt: ApiPrompt = {
      '1': {
        class_type: 'TextEncodeAceStepAudio1_5',
        inputs: { tags: 'lofi jazz, saxophone, rainy', lyrics: 'night drive...' },
      },
      '2': {
        class_type: 'SamplerCustomAdvanced',
        inputs: { positive: ['1', 0], seed: 11 },
      },
    };
    const meta = extractMetadata(prompt);
    expect(meta.promptText).toBe('lofi jazz, saxophone, rainy');
  });
});

describe('extractMetadata v4 — workflow-agnostic', () => {
  it('pulls dimensions + length + fps + models from an LTX2 subgraph workflow', () => {
    const apiPrompt = JSON.parse(readFileSync(
      resolve(FIXTURE_DIR, 'ltx2_i2v.prompt.json'), 'utf8',
    )) as ApiPrompt;
    const workflowJson = JSON.parse(readFileSync(
      resolve(FIXTURE_DIR, 'ltx2_i2v.workflow.json'), 'utf8',
    )) as unknown;

    const meta = extractMetadata(apiPrompt, workflowJson);

    // Titles in subgraph definitions are authoritative for dimensions.
    expect(meta.width).toBe(1280);
    expect(meta.height).toBe(720);
    expect(meta.length).toBe(121);
    expect(meta.fps).toBe(25);
    expect(meta.batchSize).toBe(1);

    // Sampler params come from widget scanning.
    expect(meta.sampler).toBe('euler_cfg_pp');

    // Prompt text: title-match on PrimitiveStringMultiline titled "Prompt"
    // wins over the wire chain through the Gemma generator.
    expect(meta.promptText).not.toBeNull();
    expect(meta.promptText).toContain('Egyptian royal');

    // Every loader's safetensors filename landed in the models list.
    expect(meta.models).toEqual(expect.arrayContaining([
      'ltx-2.3-22b-dev-fp8.safetensors',
      'ltx-2.3-22b-distilled-lora-384.safetensors',
      'ltx-2.3-spatial-upscaler-x2-1.1.safetensors',
      'gemma_3_12B_it_fp4_mixed.safetensors',
      'gemma-3-12b-it-abliterated_lora_rank64_bf16.safetensors',
    ]));
    // Back-compat alias: single `model` is the first of the list.
    expect(meta.model).toBeTruthy();
  });

  it('resolves trivial math expressions (a/2) on wire-connected inputs', () => {
    const prompt: ApiPrompt = {
      '10': {
        class_type: 'PrimitiveInt',
        inputs: { value: 1280 },
      },
      '20': {
        class_type: 'ComfyMathExpression',
        inputs: { expression: 'a/2', 'values.a': ['10', 0] },
      },
      '30': {
        class_type: 'EmptyLTXVLatentVideo',
        inputs: {
          width: ['20', 0],
          height: 720,
          length: 121,
          batch_size: 1,
        },
      },
    };
    const meta = extractMetadata(prompt);
    expect(meta.width).toBe(640);
    expect(meta.height).toBe(720);
    expect(meta.length).toBe(121);
  });

  it('computes durationMs from history status.messages', () => {
    const apiPrompt: ApiPrompt = {
      '1': {
        class_type: 'CLIPTextEncode',
        inputs: { text: 'a scene' },
      },
    };
    const status = [
      ['execution_start',   { prompt_id: 'p1', timestamp: 1_700_000_000_000 }],
      ['execution_cached',  { nodes: [], prompt_id: 'p1', timestamp: 1_700_000_000_010 }],
      ['execution_success', { prompt_id: 'p1', timestamp: 1_700_000_042_500 }],
    ];
    const meta = extractMetadata(apiPrompt, undefined, status);
    expect(meta.durationMs).toBe(42_500);
  });

  it('back-compat: single-argument signature still works', () => {
    const prompt: ApiPrompt = {
      '1': { class_type: 'CLIPTextEncode', inputs: { text: 'hello' } },
    };
    const meta = extractMetadata(prompt);
    expect(meta.promptText).toBe('hello');
    expect(meta.durationMs).toBeNull();
    expect(meta.width).toBeNull();
  });

  // Regression: importer paths (gallery.service.ts::syncFromComfyUI etc.) reach
  // extractMetadata with apiPrompt-only — ComfyUI's /history doesn't return the
  // workflow JSON. Without an apiPrompt-format title walk + multi-hop wire
  // chase, the extractor mislabelled LTX 2.3 i2av imports with the negative
  // encoder's default ("pc game, console game, video game, cartoon, …").
  describe('LTX 2.3 i2av — no workflowJson available', () => {
    const ltxApiPrompt: ApiPrompt = {
      '340:285': { class_type: 'RandomNoise', inputs: { noise_seed: 42 } },
      '340:290': {
        class_type: 'CFGGuider',
        inputs: { positive: ['340:306', 0], negative: ['340:314', 0] },
      },
      '340:306': {
        class_type: 'CLIPTextEncode',
        inputs: { clip: ['340:318', 0], text: ['340:342', 0] },
        _meta: { title: 'CLIP Text Encode (Prompt)' },
      } as unknown as ApiPrompt[string],
      '340:314': {
        class_type: 'CLIPTextEncode',
        inputs: {
          clip: ['340:318', 0],
          text: 'pc game, console game, video game, cartoon, childish, ugly',
        },
        _meta: { title: 'CLIP Text Encode (Prompt)' },
      } as unknown as ApiPrompt[string],
      '340:319': {
        class_type: 'PrimitiveStringMultiline',
        inputs: { value: 'The fuzzy cactus creature is talking to the viewer.' },
        _meta: { title: 'Prompt' },
      } as unknown as ApiPrompt[string],
      '340:342': {
        class_type: 'TextGenerateLTX2Prompt',
        inputs: { prompt: ['340:319', 0] },
      },
    };

    it('apiPrompt-format Primitive title pins the user prompt', () => {
      const meta = extractMetadata(ltxApiPrompt);
      expect(meta.promptText).toContain('fuzzy cactus creature');
      expect(meta.promptText).not.toContain('pc game');
    });

    it('multi-hop wire chase resolves prompt without titles', () => {
      // Strip the Primitive title so the apiPrompt-titles fallback can't fire.
      const noTitle: ApiPrompt = JSON.parse(JSON.stringify(ltxApiPrompt));
      delete (noTitle['340:319'] as unknown as { _meta?: unknown })._meta;
      // Add a sampler so resolvePromptText Step 1 (KSampler.positive) fires;
      // CFGGuider alone isn't a KSampler-typed node.
      const withSampler: ApiPrompt = {
        ...noTitle,
        sampler: {
          class_type: 'KSamplerAdvanced',
          inputs: { positive: ['340:306', 0], negative: ['340:314', 0] },
        },
      };
      const meta = extractMetadata(withSampler);
      expect(meta.promptText).toContain('fuzzy cactus creature');
    });

    it('longest-literal fallback excludes the negative encoder', () => {
      // Bypass Step 1: drop the sampler entirely so resolvePromptText reaches
      // Step 2 (longestCLIPTextEncode). Only the negative encoder has a literal
      // — historically it would have been picked. With the negative-aware
      // exclusion, we get null instead of the wrong text.
      const positiveLiteral: ApiPrompt = {
        guider: {
          class_type: 'CFGGuider',
          inputs: { positive: ['enc-pos', 0], negative: ['enc-neg', 0] },
        },
        'enc-pos': {
          class_type: 'CLIPTextEncode',
          inputs: { text: 'a short prompt' },
        },
        'enc-neg': {
          class_type: 'CLIPTextEncode',
          inputs: { text: 'pc game, console game, video game, cartoon, childish, ugly' },
        },
      };
      const meta = extractMetadata(positiveLiteral);
      expect(meta.promptText).toBe('a short prompt');
      expect(meta.negativeText).toContain('pc game');
    });
  });
});

describe('randomizeSeeds', () => {
  it('mutates seed and noise_seed widgets on KSampler variants', () => {
    const prompt: ApiPrompt = {
      '1': {
        class_type: 'KSampler',
        inputs: { seed: 1, steps: 1, cfg: 1, sampler_name: 'euler' },
      },
      '2': {
        class_type: 'KSamplerAdvanced',
        inputs: { noise_seed: 2, steps: 1, cfg: 1, sampler_name: 'euler' },
      },
      '3': {
        class_type: 'CLIPTextEncode',
        inputs: { text: 'hi', seed: 3 }, // unrelated; must not be touched.
      },
    };
    const before3Seed = prompt['3']!.inputs!.seed;
    randomizeSeeds(prompt);
    expect(prompt['1']!.inputs!.seed).not.toBe(1);
    expect(prompt['2']!.inputs!.noise_seed).not.toBe(2);
    expect(prompt['3']!.inputs!.seed).toBe(before3Seed);
  });
});
