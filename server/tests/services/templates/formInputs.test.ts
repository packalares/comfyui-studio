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
    // Wrapper node 50 instantiates sg1 — without that the flattener
    // doesn't walk subgraph definitions. Inside, a Primitive titled
    // "Prompt" coexists with a CLIPTextEncode wired upstream from a
    // sibling source (so the widget walk correctly skips it). At the
    // top-level there's also an unrelated CLIPTextEncode node 10.
    const workflow = {
      nodes: [
        { id: 10, type: 'CLIPTextEncode', title: 'Positive', widgets_values: ['fallback'] },
        { id: 50, type: 'sg1' },
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
      bindNodeId: '50:99',
      bindWidgetName: 'value',
      default: 'authored default',
    });
    // The widget walk still runs and surfaces the top-level CLIPTextEncode
    // as a second field. The primitive is prepended and keeps its title.
    expect(out.some(f => f.bindNodeId === '10' && f.bindWidgetName === 'text')).toBe(true);
  });
});

describe('generateFormInputs — wrapper-proxy prompt promotion', () => {
  // Regression for the Z-Image-Turbo Fun Union ControlNet / Flux.2 Dev t2i
  // shape: the workflow has no Primitive titled "Prompt" and the encoder's
  // text input is wired (driven by the wrapper's subgraph input port from
  // the proxy). Without promotion, Studio falls to the unbound generic
  // prompt and the user sees no main-form Prompt textbox.
  it('promotes a wrapper-proxied multiline STRING widget into a bound main-form field', () => {
    const objectInfo = {
      CLIPTextEncode: {
        input: { required: { text: STR_MULTI, clip: ['CLIP'] } },
      },
    } satisfies Record<string, Record<string, unknown>>;
    const workflow = {
      nodes: [
        {
          id: 70,
          type: 'b94257db-cdc1-45d3-8913-ca61e782d9c1',
          properties: {
            proxyWidgets: [
              ['45', 'text'],
              ['46', 'seed'],
            ],
          },
        },
      ],
      definitions: {
        subgraphs: [
          {
            id: 'b94257db-cdc1-45d3-8913-ca61e782d9c1',
            nodes: [
              {
                id: 45,
                type: 'CLIPTextEncode',
                widgets_values: ['Realistic photo of a sunlit forest, cinematic.'],
              },
            ],
          },
        ],
      },
    };
    const out = generateFormInputs(bare({ tags: ['Text to Image'] }), workflow, objectInfo);
    const prompt = out.find(f => f.id === 'text');
    expect(prompt).toBeDefined();
    expect(prompt).toMatchObject({
      id: 'text',
      label: 'Prompt',
      type: 'textarea',
      bindNodeId: '70:45',
      bindWidgetName: 'text',
      default: 'Realistic photo of a sunlit forest, cinematic.',
    });
    // No legacy unbound generic prompt should be emitted alongside.
    const unbound = out.filter(f => f.id === 'prompt' && !f.bindNodeId);
    expect(unbound).toHaveLength(0);
  });

  it('skips negative-titled inner encoders when promoting', () => {
    const objectInfo = {
      CLIPTextEncode: {
        input: { required: { text: STR_MULTI, clip: ['CLIP'] } },
      },
    } satisfies Record<string, Record<string, unknown>>;
    const workflow = {
      nodes: [
        { id: 70, type: 'sg', properties: { proxyWidgets: [['45', 'text']] } },
      ],
      definitions: {
        subgraphs: [{
          id: 'sg',
          nodes: [
            {
              id: 45, type: 'CLIPTextEncode', title: 'Negative Prompt',
              widgets_values: ['ugly, blurry'],
            },
          ],
        }],
      },
    };
    const out = generateFormInputs(bare(), workflow, objectInfo);
    expect(out.some(f => f.bindNodeId === '70:45')).toBe(false);
  });

  it('does not promote when a titled Primitive already covers the prompt', () => {
    const objectInfo = {
      CLIPTextEncode: {
        input: { required: { text: STR_MULTI, clip: ['CLIP'] } },
      },
    } satisfies Record<string, Record<string, unknown>>;
    // Encoder.text is wired (from the SubgraphInput driven by the proxy),
    // so the widget-walker correctly skips it. The primitive walk picks
    // up node 99 ("Prompt"). Promotion must not double up on the same
    // user-editable surface.
    const workflow = {
      nodes: [
        { id: 70, type: 'sg', properties: { proxyWidgets: [['45', 'text']] } },
      ],
      definitions: {
        subgraphs: [{
          id: 'sg',
          nodes: [
            { id: 99, type: 'PrimitiveStringMultiline', title: 'Prompt', widgets_values: ['authored default'] },
            {
              id: 45, type: 'CLIPTextEncode',
              inputs: [{ name: 'text', type: 'STRING', link: 1, widget: { name: 'text' } }],
              widgets_values: ['from-encoder default'],
            },
          ],
        }],
      },
    };
    const out = generateFormInputs(bare(), workflow, objectInfo);
    // Primitive wins. The walker may still emit the encoder's text widget
    // when its skip-wiring detection doesn't match the test's input shape;
    // what matters here is that the proxy promotion is GATED on
    // `promptFields.length === 0` and therefore can't add yet another
    // duplicate. Verify the prompt comes from the primitive.
    const prompt = out.find(f => f.id === 'prompt');
    expect(prompt).toBeDefined();
    expect(prompt?.bindNodeId).toBe('70:99');
    expect(prompt?.bindWidgetName).toBe('value');
    expect(prompt?.default).toBe('authored default');
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
