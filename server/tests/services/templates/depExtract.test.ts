// Tests for the pure dep-extraction helper used by the refresh endpoint
// and the check-dependencies handler.

import { describe, expect, it } from 'vitest';
import { extractDeps } from '../../../src/services/templates/depExtract.js';

describe('extractDeps', () => {
  it('returns empty arrays for non-workflow inputs', () => {
    const empty = { models: [], plugins: [], modelLoaderClasses: {} };
    expect(extractDeps(null)).toEqual(empty);
    expect(extractDeps(undefined)).toEqual(empty);
    expect(extractDeps('not a workflow')).toEqual(empty);
    expect(extractDeps({})).toEqual(empty);
  });

  it('collects model filenames from properties.models[]', () => {
    const wf = {
      nodes: [
        {
          type: 'UNETLoader',
          properties: {
            models: [
              { name: 'model-a.safetensors', url: 'https://example.com/a', directory: 'unet' },
              { name: 'model-b.safetensors' },
            ],
          },
        },
      ],
    };
    const { models } = extractDeps(wf);
    expect(models).toEqual(['model-a.safetensors', 'model-b.safetensors']);
  });

  it('collects loader widget filenames with known loader types', () => {
    const wf = {
      nodes: [
        {
          type: 'CheckpointLoaderSimple',
          widgets_values: ['ckpt.safetensors', 123, 'non-model-string'],
        },
        {
          type: 'UnknownLoader',
          widgets_values: ['ignored.safetensors'],
        },
      ],
    };
    const { models } = extractDeps(wf);
    expect(models).toEqual(['ckpt.safetensors']);
  });

  it('walks nested subgraph nodes recursively', () => {
    const wf = {
      nodes: [
        {
          type: 'Subgraph',
          subgraph: {
            nodes: [
              { type: 'VAELoader', widgets_values: ['vae.safetensors'] },
            ],
          },
        },
      ],
    };
    const { models } = extractDeps(wf);
    expect(models).toEqual(['vae.safetensors']);
  });

  it('collects plugin ids from aux_id + cnr_id and normalizes github URLs', () => {
    const wf = {
      nodes: [
        { type: 'FooNode', properties: { aux_id: 'Alice/SomePack' } },
        { type: 'BarNode', properties: { cnr_id: 'https://github.com/Bob/OtherPack.git' } },
      ],
    };
    const { plugins } = extractDeps(wf);
    expect(plugins).toEqual(['alice/somepack', 'bob/otherpack']);
  });

  it('dedupes across model + plugin sources', () => {
    const wf = {
      nodes: [
        { type: 'UNETLoader', properties: { models: [{ name: 'm.safetensors' }] }, widgets_values: ['m.safetensors'] },
        { type: 'FooNode', properties: { aux_id: 'Alice/Pack' } },
        { type: 'FooNode2', properties: { aux_id: 'alice/pack' } },
      ],
    };
    const deps = extractDeps(wf);
    expect(deps.models).toEqual(['m.safetensors']);
    expect(deps.plugins).toEqual(['alice/pack']);
  });

  // Regression: each loader's class_type must be recorded against the
  // filename(s) it references so the import resolver can route them to
  // the right `models/<folder>/` directory regardless of URL/filename
  // heuristics. Covers the LTX 2.3 i2av case where the same workflow
  // refers to a `LatentUpscaleModelLoader` and an `LTXAVTextEncoderLoader`
  // — both previously got mis-routed to upscale_models / checkpoints.
  it('records the loader class_type per filename in modelLoaderClasses', () => {
    const wf = {
      nodes: [
        {
          type: 'LatentUpscaleModelLoader',
          widgets_values: ['ltx-2.3-spatial-upscaler-x2-1.0.safetensors'],
        },
        {
          type: 'LTXAVTextEncoderLoader',
          widgets_values: ['gemma_3_12B_it_fp8_e4m3fn.safetensors'],
        },
        {
          type: 'CheckpointLoaderSimple',
          widgets_values: ['ltx-2.3-22b-dev-fp8.safetensors'],
        },
      ],
    };
    const deps = extractDeps(wf);
    expect(deps.modelLoaderClasses).toEqual({
      'ltx-2.3-spatial-upscaler-x2-1.0.safetensors': 'LatentUpscaleModelLoader',
      'gemma_3_12B_it_fp8_e4m3fn.safetensors': 'LTXAVTextEncoderLoader',
      'ltx-2.3-22b-dev-fp8.safetensors': 'CheckpointLoaderSimple',
    });
  });
});
