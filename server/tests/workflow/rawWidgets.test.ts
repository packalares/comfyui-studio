// Raw-widget pipeline tests — widgetNamesFor alignment after filtering,
// inferWidgetShape for STRING/INT/BOOLEAN, computeFormClaimedWidgets.

import { describe, expect, it } from 'vitest';
import {
  buildRawWidgetSettings,
  computeFormClaimedWidgets,
  filteredWidgetValues,
  inferWidgetShape,
  isWidgetSpec,
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

describe('modern-form COMBO (spec[0] === "COMBO")', () => {
  // Regression: ComfyUI 0.3.x serialises newer dropdown inputs as
  //   ["COMBO", { options: [...], multiselect: false }]
  // rather than the legacy
  //   [["a", "b", "c"], { default: "a" }]
  // Studio must treat BOTH as widgets or widgets_values misaligns.

  it('isWidgetSpec recognises modern COMBO form', () => {
    const modernSpec = ['COMBO', { options: ['euler', 'dpmpp_2m', 'ddim'] }];
    expect(isWidgetSpec(modernSpec)).toBe(true);
  });

  it('isWidgetSpec still recognises legacy array-form COMBO', () => {
    const legacySpec = [['euler', 'dpmpp_2m', 'ddim'], { default: 'euler' }];
    expect(isWidgetSpec(legacySpec)).toBe(true);
  });

  it('widgetNamesFor includes modern-COMBO widgets in declaration order', () => {
    // Mirrors the live TextEncodeAceStepAudio1.5 shape: three modern
    // COMBOs sandwiched between primitive widgets.
    const objectInfo = {
      TextEncodeAceStepAudio1_5: {
        input: {
          required: {
            clip: ['CLIP'], // socket, skipped
            tags: ['STRING', { multiline: true }],
            lyrics: ['STRING', { multiline: true }],
            timesignature: ['COMBO', { options: ['4/4', '3/4', '6/8'] }],
            language: ['COMBO', { options: ['en', 'zh', 'es'] }],
            keyscale: ['COMBO', { options: ['C major', 'A minor'] }],
            generate_audio_codes: ['BOOLEAN', {}],
            cfg_scale: ['FLOAT', { min: 0, max: 30 }],
            temperature: ['FLOAT', { min: 0, max: 2 }],
          },
        },
      },
    } satisfies Record<string, Record<string, unknown>>;
    const names = widgetNamesFor(objectInfo, 'TextEncodeAceStepAudio1_5');
    expect(names).toEqual([
      'tags',
      'lyrics',
      'timesignature',
      'language',
      'keyscale',
      'generate_audio_codes',
      'cfg_scale',
      'temperature',
    ]);
  });

  it('inferWidgetShape emits select with label/value pairs for modern COMBO', () => {
    const objectInfo = {
      N: {
        input: {
          required: {
            scheduler: ['COMBO', { options: ['normal', 'karras', 'exponential'] }],
          },
        },
      },
    } satisfies Record<string, Record<string, unknown>>;
    const shape = inferWidgetShape(objectInfo, 'N', 'scheduler', 'normal');
    expect(shape).toEqual({
      type: 'select',
      options: [
        { label: 'normal', value: 'normal' },
        { label: 'karras', value: 'karras' },
        { label: 'exponential', value: 'exponential' },
      ],
    });
  });

  it('inferWidgetShape emits the same select shape for legacy COMBO', () => {
    const objectInfo = {
      N: {
        input: {
          required: {
            scheduler: [['normal', 'karras', 'exponential'], { default: 'normal' }],
          },
        },
      },
    } satisfies Record<string, Record<string, unknown>>;
    const shape = inferWidgetShape(objectInfo, 'N', 'scheduler', 'normal');
    expect(shape).toEqual({
      type: 'select',
      options: [
        { label: 'normal', value: 'normal' },
        { label: 'karras', value: 'karras' },
        { label: 'exponential', value: 'exponential' },
      ],
    });
  });

  it('modern COMBO with missing options yields an empty options list', () => {
    const objectInfo = {
      N: { input: { required: { mode: ['COMBO', {}] } } },
    } satisfies Record<string, Record<string, unknown>>;
    const shape = inferWidgetShape(objectInfo, 'N', 'mode', 'x');
    expect(shape).toEqual({ type: 'select', options: [] });
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

describe('buildRawWidgetSettings — nodeId/nodeTitle attribution', () => {
  // The Advanced Settings UI groups settings by nodeId so users can tell
  // which node a widget belongs to. Both fields must propagate from the
  // source node onto the AdvancedSetting record.
  it('populates nodeId and nodeTitle from the source node', () => {
    const objectInfo = {
      VHS_LoadVideo: {
        input: {
          required: {
            video: ['STRING', {}],
            custom_width: ['INT', { min: 0 }],
            frame_load_cap: ['INT', { min: 0 }],
          },
        },
      },
    } satisfies Record<string, Record<string, unknown>>;
    const workflow = {
      nodes: [
        { id: 5, type: 'VHS_LoadVideo', title: 'Source Video',
          widgets_values: ['clip.mp4', 1024, 81] },
      ],
    };
    const exposed = [
      { nodeId: '5', widgetName: 'custom_width' },
      { nodeId: '5', widgetName: 'frame_load_cap' },
    ];
    const settings = buildRawWidgetSettings(workflow, exposed, objectInfo);
    expect(settings).toHaveLength(2);
    for (const s of settings) {
      expect(s.nodeId).toBe('5');
      expect(s.nodeTitle).toBe('Source Video');
    }
  });

  it('falls back to class type for nodeTitle when title is absent', () => {
    const objectInfo = {
      KSampler: { input: { required: { steps: ['INT', { min: 1 }] } } },
    } satisfies Record<string, Record<string, unknown>>;
    const workflow = {
      nodes: [{ id: 9, type: 'KSampler', widgets_values: [20] }],
    };
    const settings = buildRawWidgetSettings(
      workflow, [{ nodeId: '9', widgetName: 'steps' }], objectInfo,
    );
    expect(settings[0].nodeId).toBe('9');
    expect(settings[0].nodeTitle).toBe('KSampler');
  });
});
