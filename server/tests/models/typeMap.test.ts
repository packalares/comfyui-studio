// Unit tests for typeMap.ts — the shared catalog-type → dir mapping module.

import { describe, it, expect } from 'vitest';
import {
  TYPE_TO_DIR,
  CIVITAI_TYPE_TO_DIR,
  modelSaveDir,
  civitaiTypeToDir,
} from '../../src/services/models/typeMap.js';

describe('TYPE_TO_DIR', () => {
  it('covers all fundamental catalog types', () => {
    expect(TYPE_TO_DIR['checkpoint']).toBe('checkpoints');
    expect(TYPE_TO_DIR['lora']).toBe('loras');
    expect(TYPE_TO_DIR['vae']).toBe('vae');
    expect(TYPE_TO_DIR['controlnet']).toBe('controlnet');
    expect(TYPE_TO_DIR['embedding']).toBe('embeddings');
    expect(TYPE_TO_DIR['TAESD']).toBe('vae_approx');
    expect(TYPE_TO_DIR['IP-Adapter']).toBe('ipadapter');
  });
});

describe('CIVITAI_TYPE_TO_DIR', () => {
  it('covers standard CivitAI model types', () => {
    expect(CIVITAI_TYPE_TO_DIR['Checkpoint']).toBe('checkpoints');
    expect(CIVITAI_TYPE_TO_DIR['LORA']).toBe('loras');
    expect(CIVITAI_TYPE_TO_DIR['Upscaler']).toBe('upscale_models');
    expect(CIVITAI_TYPE_TO_DIR['TextualInversion']).toBe('embeddings');
  });
});

describe('modelSaveDir', () => {
  it('returns models/<subdir> for known types', () => {
    expect(modelSaveDir('checkpoint')).toBe('models/checkpoints');
    expect(modelSaveDir('lora')).toBe('models/loras');
    expect(modelSaveDir('upscaler')).toBe('models/upscale_models');
    expect(modelSaveDir('TAESD')).toBe('models/vae_approx');
  });

  it('falls back to models/checkpoints for unknown types', () => {
    expect(modelSaveDir('unknown_exotic_type')).toBe('models/checkpoints');
    expect(modelSaveDir('')).toBe('models/checkpoints');
  });
});

describe('civitaiTypeToDir', () => {
  it('resolves known CivitAI types', () => {
    expect(civitaiTypeToDir('Checkpoint')).toBe('checkpoints');
    expect(civitaiTypeToDir('LORA')).toBe('loras');
    expect(civitaiTypeToDir('TextualInversion')).toBe('embeddings');
    expect(civitaiTypeToDir('Upscaler')).toBe('upscale_models');
  });

  it('resolves case-insensitively as fallback', () => {
    expect(civitaiTypeToDir('checkpoint')).toBe('checkpoints');
    expect(civitaiTypeToDir('lora')).toBe('loras');
  });

  it('returns undefined for unknown CivitAI types', () => {
    expect(civitaiTypeToDir('WeirdCustomType')).toBeUndefined();
    expect(civitaiTypeToDir(undefined)).toBeUndefined();
    expect(civitaiTypeToDir('')).toBeUndefined();
  });
});
