import { describe, expect, it } from 'vitest';
import {
  extractHashHints,
  inferBaseModelFromContext,
} from '../../src/services/models/resolver/extractHashHints.js';

const baseNode = (overrides: object) => ({
  id: 1,
  type: 'CheckpointLoaderSimple',
  widgets_values: [],
  inputs: [],
  outputs: [],
  properties: {},
  ...overrides,
});

describe('extractHashHints', () => {
  it('returns empty array for empty workflow', () => {
    expect(extractHashHints({})).toEqual([]);
    expect(extractHashHints({ nodes: [] })).toEqual([]);
  });

  it('extracts a hint from a string widget value with an extension', () => {
    const wf = {
      nodes: [
        baseNode({
          id: 10,
          type: 'CheckpointLoaderSimple',
          widgets_values: ['flux1-dev.safetensors'],
        }),
      ],
    };
    const hints = extractHashHints(wf);
    expect(hints).toHaveLength(1);
    expect(hints[0].filename).toBe('flux1-dev.safetensors');
    expect(hints[0].nodeId).toBe('10');
  });

  it('skips widget values without a file extension', () => {
    const wf = {
      nodes: [baseNode({ id: 1, widgets_values: ['fp16', 42, true] })],
    };
    expect(extractHashHints(wf)).toHaveLength(0);
  });

  it('attaches sha256 from extra.Hashes (case-insensitive key match)', () => {
    const wf = {
      nodes: [
        baseNode({ id: 5, widgets_values: ['ae.safetensors'] }),
      ],
      extra: {
        Hashes: {
          'ae.safetensors': { sha256: 'ABCDEF1234567890abcdef1234567890abcdef1234567890abcdef1234567890' },
        },
      },
    };
    const hints = extractHashHints(wf);
    expect(hints[0].sha256).toBe('abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890');
  });

  it('attaches sha256 from properties.models[].sha256', () => {
    const wf = {
      nodes: [
        baseNode({
          id: 7,
          widgets_values: ['mymodel.safetensors'],
          properties: {
            models: [{ name: 'mymodel.safetensors', sha256: 'abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abc1' }],
          },
        }),
      ],
    };
    const hints = extractHashHints(wf);
    expect(hints[0].sha256).toBe('abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abc1');
  });

  it('returns multiple hints for multiple nodes', () => {
    const wf = {
      nodes: [
        baseNode({ id: 1, widgets_values: ['model-a.safetensors'] }),
        baseNode({ id: 2, widgets_values: ['model-b.gguf'] }),
      ],
    };
    const hints = extractHashHints(wf);
    expect(hints).toHaveLength(2);
  });
});

describe('inferBaseModelFromContext', () => {
  it('detects flux from widget value', () => {
    const wf = {
      nodes: [baseNode({ id: 1, widgets_values: ['flux1-dev.safetensors'] })],
    };
    expect(inferBaseModelFromContext(wf, '1')).toBe('flux1');
  });

  it('detects sdxl from widget value', () => {
    const wf = {
      nodes: [baseNode({ id: 2, type: 'CheckpointLoader', widgets_values: ['dreamshaper-xl.safetensors'] })],
    };
    expect(inferBaseModelFromContext(wf, '2')).toBe('sdxl');
  });

  it('returns null for unknown pattern', () => {
    const wf = {
      nodes: [baseNode({ id: 3, widgets_values: ['unknown-model.safetensors'] })],
    };
    expect(inferBaseModelFromContext(wf, '3')).toBeNull();
  });

  it('returns null when node not found', () => {
    const wf = { nodes: [baseNode({ id: 1 })] };
    expect(inferBaseModelFromContext(wf, '99')).toBeNull();
  });
});
