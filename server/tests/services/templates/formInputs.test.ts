// generateFormInputs — workflow-reading form field generation.
//
// Covers the three code paths:
//   1. Classic CLIPTextEncode workflow → single bound `prompt` textarea.
//   2. Multi-field encoder (TextEncodeAceStepAudio1.5) → one bound field
//      per multiline STRING widget.
//   3. Subgraph-Primitive workflow → fields come from Primitives, not the
//      widget walk.

import { describe, expect, it } from 'vitest';
import { generateFormInputs } from '../../../src/services/templates/templates.formInputs.js';
import type { RawTemplate } from '../../../src/services/templates/types.js';

const STR_MULTI = ['STRING', { multiline: true }];

function bare(template: Partial<RawTemplate> = {}): RawTemplate {
  return {
    name: 't',
    title: 'T',
    description: '',
    mediaType: 'image',
    ...template,
  };
}

describe('generateFormInputs — classic CLIPTextEncode', () => {
  it('emits one bound prompt field pointing at the positive CLIPTextEncode.text', () => {
    const objectInfo = {
      CLIPTextEncode: {
        input: { required: { text: STR_MULTI, clip: ['CLIP'] } },
      },
    } satisfies Record<string, Record<string, unknown>>;
    const workflow = {
      nodes: [
        { id: 10, type: 'CLIPTextEncode', title: 'Positive', widgets_values: ['a cat'] },
        { id: 11, type: 'CLIPTextEncode', title: 'Negative Prompt', widgets_values: ['ugly'] },
      ],
    };
    const out = generateFormInputs(bare({ tags: ['Text to Image'] }), workflow, objectInfo);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: 'text',
      label: 'Prompt',
      type: 'textarea',
      required: true,
      bindNodeId: '10',
      bindWidgetName: 'text',
      default: 'a cat',
    });
  });

  it('skips the negative-titled node even when it comes first in the list', () => {
    const objectInfo = {
      CLIPTextEncode: {
        input: { required: { text: STR_MULTI, clip: ['CLIP'] } },
      },
    } satisfies Record<string, Record<string, unknown>>;
    const workflow = {
      nodes: [
        { id: 11, type: 'CLIPTextEncode', title: 'Negative Prompt', widgets_values: ['ugly'] },
        { id: 10, type: 'CLIPTextEncode', title: 'Positive', widgets_values: ['dog'] },
      ],
    };
    const out = generateFormInputs(bare(), workflow, objectInfo);
    expect(out).toHaveLength(1);
    expect(out[0].bindNodeId).toBe('10');
    expect(out[0].default).toBe('dog');
  });
});

describe('generateFormInputs — multi-field encoder', () => {
  it('emits one bound field per multiline STRING widget on TextEncodeAceStepAudio1.5', () => {
    const objectInfo = {
      TextEncodeAceStepAudio1_5: {
        input: {
          required: {
            clip: ['CLIP'],
            tags: STR_MULTI,
            lyrics: STR_MULTI,
            timesignature: ['COMBO', { options: ['4/4', '3/4'] }],
            cfg_scale: ['FLOAT', { min: 0, max: 30 }],
          },
        },
      },
    } satisfies Record<string, Record<string, unknown>>;
    const workflow = {
      nodes: [
        {
          id: 42, type: 'TextEncodeAceStepAudio1_5', title: 'Audio Encode',
          widgets_values: ['pop, lofi', 'la la la', '4/4', 5.0],
        },
      ],
    };
    const out = generateFormInputs(bare(), workflow, objectInfo);
    expect(out).toHaveLength(2);
    const byId = new Map(out.map(f => [f.id, f]));
    expect(byId.get('tags')).toMatchObject({
      id: 'tags', label: 'Style Tags', type: 'textarea',
      bindNodeId: '42', bindWidgetName: 'tags', default: 'pop, lofi',
    });
    expect(byId.get('lyrics')).toMatchObject({
      id: 'lyrics', label: 'Lyrics', type: 'textarea',
      bindNodeId: '42', bindWidgetName: 'lyrics', default: 'la la la',
    });
  });
});

describe('generateFormInputs — subgraph-Primitive workflow', () => {
  it('prefers primitive-derived fields over the widget walk', () => {
    const objectInfo = {
      CLIPTextEncode: {
        input: { required: { text: STR_MULTI, clip: ['CLIP'] } },
      },
    } satisfies Record<string, Record<string, unknown>>;
    // Primitive titled "Prompt" lives inside a subgraph; a CLIPTextEncode
    // node also exists at the top level. The primitive path should win.
    const workflow = {
      nodes: [
        { id: 10, type: 'CLIPTextEncode', title: 'Positive', widgets_values: ['fallback'] },
      ],
      definitions: {
        subgraphs: [
          {
            id: 'sg1',
            nodes: [
              {
                id: 99, type: 'PrimitiveStringMultiline',
                title: 'Prompt', widgets_values: ['authored default'],
              },
            ],
          },
        ],
      },
    };
    const out = generateFormInputs(bare(), workflow, objectInfo);
    const prompt = out.find(f => f.id === 'prompt');
    expect(prompt).toBeDefined();
    expect(prompt).toMatchObject({
      id: 'prompt',
      label: 'Prompt',
      type: 'textarea',
      bindNodeId: '99',
      bindWidgetName: 'value',
      default: 'authored default',
    });
    // The widget walk still runs (dedupe is per bindNodeId+bindWidgetName),
    // so the top-level CLIPTextEncode surfaces as a second field. The
    // primitive is prepended and keeps its title.
    expect(out.some(f => f.bindNodeId === '10' && f.bindWidgetName === 'text')).toBe(true);
  });
});

describe('generateFormInputs — tag-only fallback (no workflow)', () => {
  it('falls back to the legacy unbound prompt when no workflow is provided', () => {
    const out = generateFormInputs(bare({ tags: ['Text to Image'] }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'prompt', type: 'textarea', required: true });
    expect(out[0].bindNodeId).toBeUndefined();
  });

  it('emits image upload + generic prompt for a classic image-edit template', () => {
    const tpl = bare({
      tags: ['Image Edit'],
      io: { inputs: [{ nodeId: 3, nodeType: 'LoadImage', mediaType: 'image' }] },
    });
    const out = generateFormInputs(tpl);
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe('prompt');
    expect(out[1]).toMatchObject({ id: 'image_0', type: 'image', nodeId: 3 });
  });
});
