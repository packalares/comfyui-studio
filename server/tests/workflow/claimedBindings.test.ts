// computeFormClaimedWidgets — bound-binding primary path.
//
// Separated from `rawWidgets.test.ts` so the vi.mock of the templates
// module doesn't leak into the other raw-widget suites. See also
// `claimed.ts::collectBoundPromptClaimedWidgets`.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TemplateData } from '../../src/services/templates/types.js';

// Stub `services/templates/index.js` so `getTemplate` returns whatever the
// test just registered. Lets us exercise both the bound-path primary and
// the legacy fallback without touching disk or the real cache.
let mockTpl: TemplateData | undefined = undefined;
vi.mock('../../src/services/templates/index.js', () => ({
  getTemplate: (_name: string) => mockTpl,
}));

// Import AFTER the mock so the module under test picks up the stub.
import { computeFormClaimedWidgets } from '../../src/services/workflow/rawWidgets/claimed.js';

function buildTemplate(formInputs: TemplateData['formInputs']): TemplateData {
  return {
    name: 'tpl', title: 'T', description: '', mediaType: 'image',
    tags: [], models: [], category: 'test',
    io: { inputs: [], outputs: [] },
    formInputs, thumbnail: [],
  };
}

describe('computeFormClaimedWidgets — bound path', () => {
  beforeEach(() => { mockTpl = undefined; });

  it('claims exactly the bound (bindNodeId, bindWidgetName) pairs', () => {
    mockTpl = buildTemplate([
      { id: 'tags', label: 'Style Tags', type: 'textarea', required: true,
        bindNodeId: '42', bindWidgetName: 'tags' },
      { id: 'lyrics', label: 'Lyrics', type: 'textarea', required: true,
        bindNodeId: '42', bindWidgetName: 'lyrics' },
    ]);
    const objectInfo = {
      TextEncodeAceStepAudio1_5: {
        input: {
          required: {
            tags: ['STRING', { multiline: true }],
            lyrics: ['STRING', { multiline: true }],
          },
        },
      },
    } satisfies Record<string, Record<string, unknown>>;
    const workflow = {
      nodes: [
        { id: 42, type: 'TextEncodeAceStepAudio1_5', widgets_values: ['', ''] },
      ],
    };
    const claimed = computeFormClaimedWidgets(workflow, objectInfo, 'tpl');
    expect(claimed.has('42|tags')).toBe(true);
    expect(claimed.has('42|lyrics')).toBe(true);
  });

  it('falls back to the legacy first-node heuristic when no bindings exist', () => {
    // Template with only a media-upload formInput — no prompt bindings.
    mockTpl = buildTemplate([
      { id: 'image_0', label: 'Image', type: 'image', required: true,
        nodeId: 3, nodeType: 'LoadImage', mediaType: 'image' },
    ]);
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
    const claimed = computeFormClaimedWidgets(workflow, objectInfo, 'tpl');
    // Legacy rule: first non-negative node's multiline STRING widgets only.
    expect(claimed.has('10|text')).toBe(true);
    expect(claimed.has('11|text')).toBe(false);
  });

  it('does not apply the legacy fallback once any bound field is present', () => {
    // Bound field on a DIFFERENT node than the first CLIPTextEncode. The
    // legacy path would claim node 10's `text`; the bound path must not
    // trigger it when a binding exists, even if the binding targets a
    // different node.
    mockTpl = buildTemplate([
      { id: 'primitive:99', label: 'Something', type: 'text', required: false,
        bindNodeId: '99', bindWidgetName: 'value' },
    ]);
    const objectInfo = {
      CLIPTextEncode: {
        input: { required: { text: ['STRING', { multiline: true }], clip: ['CLIP'] } },
      },
    } satisfies Record<string, Record<string, unknown>>;
    const workflow = {
      nodes: [
        { id: 10, type: 'CLIPTextEncode', title: 'Positive', widgets_values: [''] },
      ],
    };
    const claimed = computeFormClaimedWidgets(workflow, objectInfo, 'tpl');
    expect(claimed.has('99|value')).toBe(true);
    expect(claimed.has('10|text')).toBe(false);
  });
});
