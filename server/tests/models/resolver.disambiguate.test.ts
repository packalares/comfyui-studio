import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Candidate } from '../../src/services/models/resolver/sidecarDisambiguator.js';

// Mock sidecar module before importing disambiguate.
vi.mock('../../src/services/models/enrichment/sidecar.js', () => ({
  readSidecar: vi.fn(),
}));

import { disambiguate } from '../../src/services/models/resolver/sidecarDisambiguator.js';
import { readSidecar } from '../../src/services/models/enrichment/sidecar.js';

const mockReadSidecar = readSidecar as ReturnType<typeof vi.fn>;

function makeCandidate(overrides: Partial<Candidate>): Candidate {
  return {
    filename: 'ae.safetensors',
    save_path: 'checkpoints',
    abs_path: '/models/checkpoints/ae.safetensors',
    ...overrides,
  };
}

beforeEach(() => {
  mockReadSidecar.mockReset();
  mockReadSidecar.mockReturnValue(null);
});

describe('disambiguate', () => {
  it('returns empty result for empty candidates', () => {
    const result = disambiguate([], 'flux1');
    expect(result.resolved).toBeNull();
    expect(result.remaining).toHaveLength(0);
  });

  it('returns null resolved when no hint provided', () => {
    const candidates = [
      makeCandidate({ abs_path: '/models/a/ae.safetensors' }),
      makeCandidate({ abs_path: '/models/b/ae.safetensors' }),
    ];
    const result = disambiguate(candidates, null);
    expect(result.resolved).toBeNull();
    expect(result.remaining).toHaveLength(2);
  });

  it('resolves single candidate matching base_model hint', () => {
    mockReadSidecar.mockImplementation((absPath: string) => {
      if (absPath.includes('/flux/')) return { filename: 'ae.safetensors', save_path: 'flux', base_model: 'flux1' };
      return { filename: 'ae.safetensors', save_path: 'sdxl', base_model: 'sdxl' };
    });

    const candidates = [
      makeCandidate({ abs_path: '/models/flux/ae.safetensors', save_path: 'flux' }),
      makeCandidate({ abs_path: '/models/sdxl/ae.safetensors', save_path: 'sdxl' }),
    ];
    const result = disambiguate(candidates, 'flux1');
    expect(result.resolved).not.toBeNull();
    expect(result.resolved?.save_path).toBe('flux');
    expect(result.resolved?.base_model).toBe('flux1');
  });

  it('returns null resolved when multiple candidates match hint', () => {
    mockReadSidecar.mockReturnValue({ filename: 'ae.safetensors', save_path: 'flux', base_model: 'flux1' });

    const candidates = [
      makeCandidate({ abs_path: '/models/flux1/ae.safetensors', save_path: 'flux1' }),
      makeCandidate({ abs_path: '/models/flux2/ae.safetensors', save_path: 'flux2' }),
    ];
    const result = disambiguate(candidates, 'flux1');
    expect(result.resolved).toBeNull();
    expect(result.remaining).toHaveLength(2);
  });

  it('returns null resolved when no candidates match hint', () => {
    mockReadSidecar.mockReturnValue({ filename: 'ae.safetensors', save_path: 'sdxl', base_model: 'sdxl' });

    const candidates = [
      makeCandidate({ abs_path: '/models/sdxl/ae.safetensors' }),
    ];
    const result = disambiguate(candidates, 'flux1');
    expect(result.resolved).toBeNull();
    expect(result.remaining).toHaveLength(1);
  });

  it('populates enrichment from sidecar when available', () => {
    const sidecarData = { filename: 'ae.safetensors', save_path: 'flux', base_model: 'flux1' };
    mockReadSidecar.mockReturnValue(sidecarData);

    const candidates = [makeCandidate({ abs_path: '/models/flux/ae.safetensors' })];
    const result = disambiguate(candidates, null);
    expect(result.remaining[0].enrichment).toEqual(sidecarData);
    expect(result.remaining[0].base_model).toBe('flux1');
  });
});
