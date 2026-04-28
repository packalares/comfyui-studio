// Smoke test for the loader-class → folder lookup. Keeps the static map
// honest (a typo on either side breaks the LTX 2.3 i2av import path).

import { describe, expect, it } from 'vitest';
import { folderForLoaderClass, LOADER_CLASS_FOLDER } from '../../../src/services/workflow/loaderFolders.js';

describe('folderForLoaderClass', () => {
  it('returns latent_upscale_models for LatentUpscaleModelLoader', () => {
    expect(folderForLoaderClass('LatentUpscaleModelLoader')).toBe('latent_upscale_models');
  });

  it('returns text_encoders for LTXAVTextEncoderLoader', () => {
    expect(folderForLoaderClass('LTXAVTextEncoderLoader')).toBe('text_encoders');
  });

  it('returns upscale_models for the plain UpscaleModelLoader (kept distinct from latent variant)', () => {
    expect(folderForLoaderClass('UpscaleModelLoader')).toBe('upscale_models');
  });

  it('returns undefined for unknown loaders so callers can fall back', () => {
    expect(folderForLoaderClass('TotallyUnknownLoader')).toBeUndefined();
    expect(folderForLoaderClass(undefined)).toBeUndefined();
    expect(folderForLoaderClass('')).toBeUndefined();
  });

  it('every value is a known ComfyUI folder name (sanity check on map entries)', () => {
    const KNOWN = new Set([
      'checkpoints', 'loras', 'vae', 'embeddings', 'hypernetworks',
      'clip', 'clip_vision', 'controlnet', 'inpaint', 'upscale_models',
      'latent_upscale_models', 'ipadapter', 'unet', 'style_models',
      'facerestore_models', 'diffusion_models', 'text_encoders',
      'gligen', 'photomaker',
    ]);
    for (const [cls, folder] of Object.entries(LOADER_CLASS_FOLDER)) {
      expect(KNOWN.has(folder), `${cls} -> ${folder} not in known set`).toBe(true);
    }
  });
});
