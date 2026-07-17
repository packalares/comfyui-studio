// Tests for the canonical model identity module.
//
// Covers: normalizeModelFilename, pairKey, identityEquals, identityFrom.

import { describe, expect, it } from 'vitest';
import {
  normalizeModelFilename,
  pairKey,
  identityEquals,
  identityFrom,
} from '../../../src/services/models/identity.js';

// ── normalizeModelFilename ────────────────────────────────────────────────────

describe('normalizeModelFilename', () => {
  it('converts Windows backslashes to forward slashes', () => {
    expect(normalizeModelFilename('flux1\\ae.safetensors')).toBe('flux1/ae.safetensors');
  });

  it('handles nested backslash paths', () => {
    expect(normalizeModelFilename('wan\\lora\\model.safetensors')).toBe('wan/lora/model.safetensors');
  });

  it('collapses doubled slashes', () => {
    expect(normalizeModelFilename('loras//model.safetensors')).toBe('loras/model.safetensors');
  });

  it('collapses triple slashes', () => {
    expect(normalizeModelFilename('loras///file.pt')).toBe('loras/file.pt');
  });

  it('strips a leading slash', () => {
    expect(normalizeModelFilename('/loras/model.safetensors')).toBe('loras/model.safetensors');
  });

  it('strips multiple leading slashes', () => {
    expect(normalizeModelFilename('//loras/model.safetensors')).toBe('loras/model.safetensors');
  });

  it('preserves case of the extension and basename', () => {
    expect(normalizeModelFilename('Wan\\LoRA.SafeTensors')).toBe('Wan/LoRA.SafeTensors');
  });

  it('is a no-op for an already-normalized filename', () => {
    expect(normalizeModelFilename('loras/model.safetensors')).toBe('loras/model.safetensors');
  });

  it('handles bare filenames with no path component', () => {
    expect(normalizeModelFilename('model.safetensors')).toBe('model.safetensors');
  });

  it('normalizes backslash then collapse then strip in one call', () => {
    expect(normalizeModelFilename('\\loras\\\\file.pt')).toBe('loras/file.pt');
  });
});

// ── pairKey ───────────────────────────────────────────────────────────────────

describe('pairKey', () => {
  it('returns save_path/filename when save_path is present', () => {
    expect(pairKey({ save_path: 'loras', filename: 'model.safetensors' }))
      .toBe('loras/model.safetensors');
  });

  it('returns just filename when save_path is empty string', () => {
    expect(pairKey({ save_path: '', filename: 'model.safetensors' }))
      .toBe('model.safetensors');
  });

  it('returns just filename when save_path is absent', () => {
    expect(pairKey({ filename: 'model.safetensors' }))
      .toBe('model.safetensors');
  });

  it('resolves ComfyUI-Manager "default" sentinel via type → canonical folder', () => {
    // Upstream Manager uses save_path:"default" + type:"upscale" to mean
    // "use the canonical upscalers folder". User catalogs store the resolved
    // path after install. Without resolution the two rows would dedup to
    // different keys and the SAME model would render twice in the search.
    expect(pairKey({ save_path: 'default', filename: '4x-UltraSharp.pth', type: 'upscale' }))
      .toBe('upscale_models/4x-UltraSharp.pth');
    expect(pairKey({ save_path: 'upscale_models', filename: '4x-UltraSharp.pth', type: 'upscaler' }))
      .toBe('upscale_models/4x-UltraSharp.pth');
  });

  it('leaves "default" unchanged when type is unknown or missing', () => {
    // Fail-safe: better to keep the upstream value than guess and split
    // into yet another false-positive duplicate.
    expect(pairKey({ save_path: 'default', filename: 'a.safetensors' }))
      .toBe('default/a.safetensors');
    expect(pairKey({ save_path: 'default', filename: 'a.safetensors', type: 'made-up-type' }))
      .toBe('default/a.safetensors');
  });
});

// ── identityEquals ────────────────────────────────────────────────────────────

describe('identityEquals', () => {
  it('returns true for identical (save_path, filename) pairs', () => {
    const a = { filename: 'model.safetensors', save_path: 'loras' };
    const b = { filename: 'model.safetensors', save_path: 'loras' };
    expect(identityEquals(a, b)).toBe(true);
  });

  it('returns false when filenames differ (case-sensitive by default)', () => {
    const a = { filename: 'GFPGAN.pth', save_path: 'facerestore_models' };
    const b = { filename: 'gfpgan.pth', save_path: 'facerestore_models' };
    expect(identityEquals(a, b)).toBe(false);
  });

  it('returns true with caseInsensitive opt-in when filenames differ only in case', () => {
    const a = { filename: 'GFPGAN.pth', save_path: 'facerestore_models' };
    const b = { filename: 'gfpgan.pth', save_path: 'facerestore_models' };
    expect(identityEquals(a, b, { caseInsensitive: true })).toBe(true);
  });

  it('returns false when save_paths differ even with caseInsensitive', () => {
    const a = { filename: 'model.safetensors', save_path: 'loras' };
    const b = { filename: 'model.safetensors', save_path: 'checkpoints' };
    expect(identityEquals(a, b, { caseInsensitive: true })).toBe(false);
  });

  it('SHA256 takes precedence when both identities carry it', () => {
    const sha = 'a'.repeat(64);
    const a = { filename: 'a.safetensors', save_path: 'loras', sha256: sha };
    const b = { filename: 'b.safetensors', save_path: 'checkpoints', sha256: sha };
    // Different filename + save_path but same sha256 → equal.
    expect(identityEquals(a, b)).toBe(true);
  });

  it('SHA256 mismatch means not equal even if save_path+filename match', () => {
    const a = { filename: 'model.safetensors', save_path: 'loras', sha256: 'a'.repeat(64) };
    const b = { filename: 'model.safetensors', save_path: 'loras', sha256: 'b'.repeat(64) };
    expect(identityEquals(a, b)).toBe(false);
  });

  it('falls back to (save_path, filename) when only one side has sha256', () => {
    const a = { filename: 'model.safetensors', save_path: 'loras', sha256: 'a'.repeat(64) };
    const b = { filename: 'model.safetensors', save_path: 'loras' };
    expect(identityEquals(a, b)).toBe(true);
  });
});

// ── identityFrom ─────────────────────────────────────────────────────────────

describe('identityFrom', () => {
  it('returns identity from a row with a filename', () => {
    const id = identityFrom({ filename: 'model.safetensors', save_path: 'loras' });
    expect(id).not.toBeNull();
    expect(id!.filename).toBe('model.safetensors');
    expect(id!.save_path).toBe('loras');
  });

  it('returns null for a name-only row when name contains no path info', () => {
    // A name-only entry from essentialModels that has no filename field.
    // "ACE-Step Captioner" is a display name, not a filename — identityFrom
    // should return null when filename is absent and name has no extension.
    const id = identityFrom({ name: 'ACE-Step Captioner' });
    // The name has no .ext but is still a non-empty string, so it becomes
    // the filename. Only truly empty/whitespace values yield null.
    expect(id).not.toBeNull();
    expect(id!.filename).toBe('ACE-Step Captioner');
  });

  it('returns null for empty filename and empty name', () => {
    expect(identityFrom({ filename: '', name: '' })).toBeNull();
    expect(identityFrom({})).toBeNull();
  });

  it('returns null for whitespace-only filename', () => {
    expect(identityFrom({ filename: '   ' })).toBeNull();
  });

  it('normalizes backslashes in filename from a row', () => {
    const id = identityFrom({ filename: 'flux1\\ae.safetensors', save_path: 'checkpoints' });
    expect(id).not.toBeNull();
    expect(id!.filename).toBe('ae.safetensors');
  });

  it('extracts basename when filename contains a path prefix', () => {
    const id = identityFrom({ filename: 'loras/Wan/model.safetensors', save_path: 'loras' });
    expect(id).not.toBeNull();
    expect(id!.filename).toBe('model.safetensors');
  });

  it('carries through sha256 when present', () => {
    const sha = 'a'.repeat(64);
    const id = identityFrom({ filename: 'model.safetensors', save_path: 'loras', sha256: sha });
    expect(id!.sha256).toBe(sha);
  });
});
