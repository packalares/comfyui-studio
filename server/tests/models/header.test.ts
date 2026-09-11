import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSafetensorsHeader } from '../../src/services/models/header/safetensors.js';
import { parseModelHeader, type ModelHeader } from '../../src/services/models/header/index.js';
import { detectArch } from '../../src/services/models/arch/detect.js';

let tmp: string;
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdr-')); });
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

function writeSafetensors(name: string, header: Record<string, unknown>): string {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(json.length));
  const p = path.join(tmp, name);
  fs.writeFileSync(p, Buffer.concat([len, json, Buffer.alloc(128)]));
  return p;
}

// Minimal ModelHeader for detectArch unit tests.
function mh(keys: string[], opts: Partial<ModelHeader> = {}): ModelHeader {
  return {
    format: 'safetensors', ok: true, integrity: 'ok',
    keys, shapes: {}, dtypes: {}, metadata: {}, paramTotal: 0, ...opts,
  };
}

describe('readSafetensorsHeader', () => {
  it('parses keys, shapes, dtypes, metadata, param count', () => {
    const p = writeSafetensors('ok.safetensors', {
      '__metadata__': { 'modelspec.architecture': 'Flux.1-dev' },
      'double_blocks.0.img_attn.qkv.weight': { dtype: 'BF16', shape: [9216, 3072], data_offsets: [0, 4] },
      'single_blocks.0.linear1.weight': { dtype: 'BF16', shape: [21504, 3072], data_offsets: [4, 8] },
    });
    const h = readSafetensorsHeader(p);
    expect(h.ok).toBe(true);
    expect(h.integrity).toBe('ok');
    expect(h.keys).toContain('double_blocks.0.img_attn.qkv.weight');
    expect(h.dtypes['single_blocks.0.linear1.weight']).toBe('BF16');
    expect(h.metadata['modelspec.architecture']).toBe('Flux.1-dev');
    expect(h.paramTotal).toBe(9216 * 3072 + 21504 * 3072);
  });

  it('flags HTML/LFS pointer as not_a_model', () => {
    const p = path.join(tmp, 'lfs.safetensors');
    fs.writeFileSync(p, 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\n');
    expect(readSafetensorsHeader(p).integrity).toBe('not_a_model');
  });

  it('flags an impossible header length as invalid_header', () => {
    const p = path.join(tmp, 'bad.safetensors');
    const len = Buffer.alloc(8); len.writeBigUInt64LE(BigInt(9_999_999));
    fs.writeFileSync(p, Buffer.concat([len, Buffer.from('{}')])); // tiny file, huge declared header
    expect(readSafetensorsHeader(p).integrity).toBe('invalid_header');
  });

  it('flags a header with zero tensors as invalid_header', () => {
    const p = writeSafetensors('empty.safetensors', { '__metadata__': { a: 'b' } });
    expect(readSafetensorsHeader(p).integrity).toBe('invalid_header');
  });

  it('dispatches via parseModelHeader by extension', () => {
    const p = writeSafetensors('x.safetensors', { 't.weight': { dtype: 'F16', shape: [2, 2], data_offsets: [0, 8] } });
    const h = parseModelHeader(p);
    expect(h.format).toBe('safetensors');
    expect(h.ok).toBe(true);
  });

  it('unknown extension -> unsupported_format', () => {
    expect(parseModelHeader('/tmp/x.ckpt').integrity).toBe('unsupported_format');
  });
});

describe('detectArch', () => {
  it('FLUX.1 from structural signature', () => {
    const r = detectArch(mh([
      'double_blocks.0.img_attn.qkv.weight', 'single_blocks.0.linear1.weight',
      'img_in.weight', 'txt_in.weight',
    ]));
    expect(r.archFamily).toBe('FLUX.1');
    expect(r.role).toBe('diffusion_model');
    expect(r.archSource).toBe('structural');
  });

  it('metadata overrides structural (FLUX.2)', () => {
    const r = detectArch(mh(
      ['double_blocks.0.img_attn.qkv.weight', 'single_blocks.0.x.weight', 'img_in.weight', 'txt_in.weight'],
      { metadata: { 'modelspec.architecture': 'FLUX.2-klein' } },
    ));
    expect(r.archFamily).toBe('FLUX.2');
    expect(r.archSource).toBe('metadata');
    expect(r.archConfidence).toBeGreaterThan(0.9);
  });

  it('SDXL from UNet keys + cross-attn shape probe (2048)', () => {
    const r = detectArch(mh(
      ['input_blocks.0.0.weight', 'middle_block.1.weight', 'output_blocks.0.0.weight',
       'time_embed.0.weight', 'input_blocks.4.1.transformer_blocks.0.attn2.to_k.weight'],
      { shapes: { 'input_blocks.4.1.transformer_blocks.0.attn2.to_k.weight': [640, 2048] } },
    ));
    expect(r.archFamily).toBe('SDXL');
    expect(r.archSource).toBe('shape');
  });

  it('standalone VAE (negative-gated)', () => {
    const r = detectArch(mh(['encoder.down.0.block.0.norm1.weight', 'decoder.up.0.block.0.norm1.weight']));
    expect(r.archFamily).toBe('VAE');
    expect(r.role).toBe('vae');
  });

  it('LoRA -> role lora with rank + family from metadata', () => {
    const r = detectArch(mh(
      ['lora_unet_x.lora_down.weight', 'lora_unet_x.lora_up.weight'],
      { shapes: { 'lora_unet_x.lora_down.weight': [16, 320], 'lora_unet_x.lora_up.weight': [320, 16] },
        metadata: { 'ss_base_model_version': 'sdxl_base_v1-0' } },
    ));
    expect(r.role).toBe('lora');
    expect(r.archFamily).toBe('SDXL');
    expect(r.signals.join(' ')).toMatch(/rank=16/);
  });

  it('precision from dtypes (bf16, and fp8 quant)', () => {
    const bf = detectArch(mh(['double_blocks.0.w', 'single_blocks.0.w', 'img_in.weight', 'txt_in.weight'],
      { dtypes: { 'double_blocks.0.w': 'BF16', 'single_blocks.0.w': 'BF16' },
        shapes: { 'double_blocks.0.w': [100], 'single_blocks.0.w': [100] } }));
    expect(bf.precision).toBe('bf16');

    const fp8 = detectArch(mh(['double_blocks.0.w', 'single_blocks.0.w', 'img_in.weight', 'txt_in.weight'],
      { dtypes: { 'double_blocks.0.w': 'F8_E4M3', 'single_blocks.0.w': 'F8_E4M3' },
        shapes: { 'double_blocks.0.w': [100], 'single_blocks.0.w': [100] } }));
    expect(fp8.precision).toBe('fp8_e4m3');
    expect(fp8.quantization).toBe('fp8_e4m3');
  });

  it('unreadable header -> Unknown; parsed-but-unmatched -> Other', () => {
    expect(detectArch(mh([], { ok: false, integrity: 'truncated' })).archFamily).toBe('Unknown');
    const other = detectArch(mh(['some.random.weight', 'other.thing.bias']));
    expect(other.archFamily).toBe('Other');
    expect(other.archSource).toBe('prior');
  });
});
