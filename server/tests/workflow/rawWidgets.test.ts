// Raw-widget pipeline tests — widgetNamesFor alignment after filtering,
// inferWidgetShape for STRING/INT/BOOLEAN, computeFormClaimedWidgets.

import { describe, expect, it } from 'vitest';
import {
  computeFormClaimedWidgets,
  filteredWidgetValues,
  inferWidgetShape,
  widgetNamesFor,
} from '../../src/services/workflow/rawWidgets/index.js';

describe('filteredWidgetValues', () => {
  it('strips randomize/fixed/increment/decrement', () => {
    const wv = [42, 'randomize', 20, 'fixed', 7.5];
    expect(filteredWidgetValues(wv)).toEqual([42, 20, 7.5]);
  });

  it('returns an empty array for undefined input', () => {
    expect(filteredWidgetValues(undefined)).toEqual([]);
  });
});

describe('widgetNamesFor', () => {
  it('produces names aligned with filtered widgets_values for KSampler', () => {
    const objectInfo = {
      KSampler: {
        input: {
          required: {
            seed: ['INT', { min: 0 }],
            steps: ['INT', { min: 1 }],
            cfg: ['FLOAT', {}],
            sampler_name: [['euler']],
            scheduler: [['normal']],
            denoise: ['FLOAT', { min: 0, max: 1 }],
            model: ['MODEL'], // connection, skipped
            positive: ['CONDITIONING'], // connection, skipped
          },
        },
      },
    } satisfies Record<string, Record<string, unknown>>;
    const names = widgetNamesFor(objectInfo, 'KSampler');
    expect(names).toEqual(['seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise']);
    // Simulate the UI-format widgets_values with the 'randomize' phantom.
    const wv = [42, 'randomize', 20, 7.5, 'euler', 'normal', 1.0];
    const filtered = filteredWidgetValues(wv);
    expect(filtered.length).toBe(names.length);
    expect(filtered[0]).toBe(42);   // seed
    expect(filtered[1]).toBe(20);   // steps
    expect(filtered[2]).toBe(7.5);  // cfg
  });
});

describe('inferWidgetShape', () => {
  const objectInfo = {
    X: {
      input: {
        required: {
          prompt: ['STRING', { multiline: true }],
          filename_prefix: ['STRING', {}],
          steps: ['INT', { min: 1, max: 100, step: 1 }],
          enabled: ['BOOLEAN', {}],
        },
      },
    },
  } satisfies Record<string, Record<string, unknown>>;

  it('STRING multiline -> textarea', () => {
    expect(inferWidgetShape(objectInfo, 'X', 'prompt', '').type).toBe('textarea');
  });

  it('STRING single-line -> text', () => {
    expect(inferWidgetShape(objectInfo, 'X', 'filename_prefix', '').type).toBe('text');
  });

  it('INT with bounds -> number with min/max/step', () => {
    const shape = inferWidgetShape(objectInfo, 'X', 'steps', 20);
    // Note: KNOWN_SETTINGS('steps') wins with a slider, so this also
    // documents that known-setting entries shadow per-spec inference.
    expect(shape.type).toBe('slider');
  });

  it('INT with no KNOWN_SETTINGS entry -> number with bounds from spec', () => {
    const info = {
      X: { input: { required: { foo: ['INT', { min: 5, max: 15, step: 2 }] } } },
    } satisfies Record<string, Record<string, unknown>>;
    const shape = inferWidgetShape(info, 'X', 'foo', 10);
    expect(shape).toEqual({ type: 'number', min: 5, max: 15, step: 2 });
  });

  it('BOOLEAN -> toggle', () => {
    expect(inferWidgetShape(objectInfo, 'X', 'enabled', true).type).toBe('toggle');
  });
});

describe('computeFormClaimedWidgets', () => {
  it('claims multiline STRING widgets on the first non-negative node only', () => {
    const objectInfo = {
      CLIPTextEncode: {
        input: { required: { text: ['STRING', { multiline: true }], clip: ['CLIP'] } },
      },
    } satisfies Record<string, Record<string, unknown>>;
    const workflow = {
      nodes: [
        { id: 10, type: 'CLIPTextEncode', title: 'Positive', widgets_values: [''] },
        { id: 11, type: 'CLIPTextEncode', title: 'Negative', widgets_values: [''] },
      ],
    };
    const claimed = computeFormClaimedWidgets(workflow, objectInfo, 'nonexistent-template');
    // Only the positive (id 10) node is claimed for the `text` widget.
    expect(claimed.has('10|text')).toBe(true);
    expect(claimed.has('11|text')).toBe(false);
  });

  it('returns an empty set when no multiline STRING nodes exist', () => {
    const objectInfo = {
      KSampler: { input: { required: { seed: ['INT', {}] } } },
    } satisfies Record<string, Record<string, unknown>>;
    const workflow = {
      nodes: [
        { id: 1, type: 'KSampler', widgets_values: [42, 'randomize'] },
      ],
    };
    const claimed = computeFormClaimedWidgets(workflow, objectInfo, 'nonexistent-template');
    expect(claimed.size).toBe(0);
  });
});
