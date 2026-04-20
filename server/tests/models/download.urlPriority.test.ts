// Unit tests for URL building in `services/models/download.service.ts`.
//
// The priority order (hf -> mirror -> cdn) and the huggingface.co -> hf-mirror
// rewrite are launcher invariants the studio port must preserve.

import { describe, expect, it } from 'vitest';
import {
  buildDownloadUrl, getAllDownloadUrls, validateHfUrl, buildResolveUrl,
  inferModelType, getModelSaveDir,
} from '../../src/services/models/download.service.js';

describe('buildDownloadUrl', () => {
  it('prefers hf when source = hf', () => {
    const url = buildDownloadUrl({
      name: 'foo', save_path: 'checkpoints',
      url: { hf: 'https://huggingface.co/foo', mirror: 'https://hf-mirror.com/foo' },
    }, 'hf');
    expect(url).toBe('https://huggingface.co/foo');
  });

  it('picks mirror when source = mirror', () => {
    const url = buildDownloadUrl({
      name: 'foo', save_path: 'checkpoints',
      url: { hf: 'https://huggingface.co/foo', mirror: 'https://hf-mirror.com/foo' },
    }, 'mirror');
    expect(url).toBe('https://hf-mirror.com/foo');
  });

  it('picks cdn when source = cdn and cdn is set', () => {
    const url = buildDownloadUrl({
      name: 'foo', save_path: 'checkpoints',
      url: { hf: 'https://huggingface.co/foo', cdn: 'https://cdn.example/foo' },
    }, 'cdn');
    expect(url).toBe('https://cdn.example/foo');
  });

  it('falls back to hf when requested source is absent', () => {
    const url = buildDownloadUrl({
      name: 'foo', save_path: 'checkpoints',
      url: { hf: 'https://huggingface.co/foo' },
    }, 'cdn');
    expect(url).toBe('https://huggingface.co/foo');
  });

  it('rewrites huggingface.co to hf-mirror when source != hf and url is string', () => {
    const url = buildDownloadUrl({
      name: 'foo', save_path: 'checkpoints',
      url: 'https://huggingface.co/foo.safetensors',
    }, 'mirror');
    expect(url).toBe('https://hf-mirror.com/foo.safetensors');
  });

  it('leaves string url unchanged when source = hf', () => {
    const url = buildDownloadUrl({
      name: 'foo', save_path: 'checkpoints',
      url: 'https://huggingface.co/foo.safetensors',
    }, 'hf');
    expect(url).toBe('https://huggingface.co/foo.safetensors');
  });
});

describe('getAllDownloadUrls', () => {
  it('returns primary then cdn then alternate', () => {
    const urls = getAllDownloadUrls({
      name: 'foo', save_path: 'checkpoints',
      url: {
        hf: 'https://huggingface.co/foo',
        mirror: 'https://hf-mirror.com/foo',
        cdn: 'https://cdn.example/foo',
      },
    }, 'hf');
    expect(urls.map(u => u.source)).toEqual(['hf', 'cdn', 'mirror']);
  });

  it('puts mirror first when source = mirror', () => {
    const urls = getAllDownloadUrls({
      name: 'foo', save_path: 'checkpoints',
      url: {
        hf: 'https://huggingface.co/foo', mirror: 'https://hf-mirror.com/foo',
      },
    }, 'mirror');
    expect(urls[0]).toEqual({ url: 'https://hf-mirror.com/foo', source: 'mirror' });
    expect(urls[1]).toEqual({ url: 'https://huggingface.co/foo', source: 'hf' });
  });
});

describe('validateHfUrl', () => {
  it('accepts a well-formed HF URL', () => {
    const r = validateHfUrl('https://huggingface.co/foo/bar/resolve/main/model.safetensors');
    expect(r.isValid).toBe(true);
    expect(r.fileName).toBe('model.safetensors');
  });

  it('accepts hf-mirror.com URLs', () => {
    const r = validateHfUrl('https://hf-mirror.com/foo/bar/resolve/main/model.pt');
    expect(r.isValid).toBe(true);
  });

  it('rejects non-HF hosts', () => {
    const r = validateHfUrl('https://example.com/foo');
    expect(r.isValid).toBe(false);
    expect(r.error).toMatch(/Hugging Face/);
  });

  it('rejects malformed URLs', () => {
    const r = validateHfUrl('not a url');
    expect(r.isValid).toBe(false);
  });
});

describe('buildResolveUrl', () => {
  it('replaces /blob/ with /resolve/', () => {
    expect(buildResolveUrl('https://huggingface.co/foo/blob/main/x.safetensors'))
      .toBe('https://huggingface.co/foo/resolve/main/x.safetensors');
  });

  it('leaves already-resolved URLs alone', () => {
    const u = 'https://huggingface.co/foo/resolve/main/x.safetensors';
    expect(buildResolveUrl(u)).toBe(u);
  });
});

describe('inferModelType + getModelSaveDir', () => {
  it('maps .safetensors with lora in name to lora', () => {
    expect(inferModelType('myLora.safetensors')).toBe('lora');
  });

  it('maps ckpt to checkpoint', () => {
    expect(inferModelType('model.ckpt')).toBe('checkpoint');
  });

  it('maps .pth with upscale to upscaler', () => {
    expect(inferModelType('upscale_x4.pth')).toBe('upscaler');
  });

  it('save dir matches launcher mapping', () => {
    expect(getModelSaveDir('lora')).toBe('models/loras');
    expect(getModelSaveDir('vae')).toBe('models/vae');
    expect(getModelSaveDir('checkpoint')).toBe('models/checkpoints');
    expect(getModelSaveDir('unknown')).toBe('models/checkpoints');
  });
});
