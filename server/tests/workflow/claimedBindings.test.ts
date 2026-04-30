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

  it('claims widget-walk bindings on every encoder, not just the first', () => {
    // Two non-negative encoders: under the legacy first-node heuristic only
    // node 10's text would be claimed. The plan-based claim emits a binding
    // for every eligible widget on every non-negative node, so both surface.
    mockTpl = buildTemplate([]);
    const objectInfo = {
      CLIPTextEncode: {
        input: { required: { text: ['STRING', { multiline: true }], clip: ['CLIP'] } },
      },
    } satisfies Record<string, Record<string, unknown>>;
    const workflow = {
      nodes: [
        { id: 10, type: 'CLIPTextEncode', title: 'Positive', widgets_values: [''] },
        { id: 11, type: 'CLIPTextEncode', title: 'Refiner Positive', widgets_values: [''] },
      ],
    };
    const claimed = computeFormClaimedWidgets(workflow, objectInfo, 'tpl');
    expect(claimed.has('10|text')).toBe(true);
    expect(claimed.has('11|text')).toBe(true);
  });
});

// `collectFormInputClaimedWidgets` previously claimed every widget on a
// form-bound media node, locking config widgets like VHS_LoadVideo's
// `custom_width` / `frame_load_cap` out of the ExposeWidgets modal. The fix
// scopes claims to the upload widget(s) for the formInput's mediaType.
describe('computeFormClaimedWidgets — media-upload claim allowlist', () => {
  beforeEach(() => { mockTpl = undefined; });

  it('claims only image + upload on a LoadImage formInput, leaving other widgets free', () => {
    mockTpl = buildTemplate([
      { id: 'image_0', label: 'Image', type: 'image', required: true,
        nodeId: 3, nodeType: 'LoadImage', mediaType: 'image' },
    ]);
    const objectInfo = {
      LoadImage: {
        input: {
          required: {
            image: ['STRING', {}],
            upload: ['BOOLEAN', {}],
            extra_setting: ['INT', {}],
          },
        },
      },
    } satisfies Record<string, Record<string, unknown>>;
    const workflow = {
      nodes: [
        { id: 3, type: 'LoadImage', widgets_values: ['cat.png', true, 0] },
      ],
    };
    const claimed = computeFormClaimedWidgets(workflow, objectInfo, 'tpl');
    expect(claimed.has('3|image')).toBe(true);
    expect(claimed.has('3|upload')).toBe(true);
    expect(claimed.has('3|extra_setting')).toBe(false);
  });

  it('claims only video on a VHS_LoadVideo formInput, leaving config widgets free', () => {
    mockTpl = buildTemplate([
      { id: 'video_0', label: 'Video', type: 'video', required: true,
        nodeId: 5, nodeType: 'VHS_LoadVideo', mediaType: 'video' },
    ]);
    // VHS_LoadVideo widget order verified: video, force_rate, custom_width,
    // custom_height, frame_load_cap, skip_first_frames, select_every_nth.
    const objectInfo = {
      VHS_LoadVideo: {
        input: {
          required: {
            video: ['STRING', {}],
            force_rate: ['FLOAT', {}],
            custom_width: ['INT', {}],
            custom_height: ['INT', {}],
            frame_load_cap: ['INT', {}],
            skip_first_frames: ['INT', {}],
            select_every_nth: ['INT', {}],
          },
        },
      },
    } satisfies Record<string, Record<string, unknown>>;
    const workflow = {
      nodes: [
        { id: 5, type: 'VHS_LoadVideo',
          widgets_values: ['clip.mp4', 0, 0, 0, 81, 0, 1] },
      ],
    };
    const claimed = computeFormClaimedWidgets(workflow, objectInfo, 'tpl');
    expect(claimed.has('5|video')).toBe(true);
    // Config widgets must remain user-exposable.
    expect(claimed.has('5|custom_width')).toBe(false);
    expect(claimed.has('5|custom_height')).toBe(false);
    expect(claimed.has('5|frame_load_cap')).toBe(false);
    expect(claimed.has('5|skip_first_frames')).toBe(false);
    expect(claimed.has('5|select_every_nth')).toBe(false);
    expect(claimed.has('5|force_rate')).toBe(false);
  });

  it('claims audio + audio_file on an audio formInput', () => {
    mockTpl = buildTemplate([
      { id: 'audio_0', label: 'Audio', type: 'audio', required: true,
        nodeId: 7, nodeType: 'VHS_LoadAudio', mediaType: 'audio' },
    ]);
    const objectInfo = {
      VHS_LoadAudio: {
        input: {
          required: {
            audio: ['STRING', {}],
            audio_file: ['STRING', {}],
            seek_seconds: ['FLOAT', {}],
          },
        },
      },
    } satisfies Record<string, Record<string, unknown>>;
    const workflow = {
      nodes: [
        { id: 7, type: 'VHS_LoadAudio',
          widgets_values: ['song.flac', 'song.flac', 0] },
      ],
    };
    const claimed = computeFormClaimedWidgets(workflow, objectInfo, 'tpl');
    expect(claimed.has('7|audio')).toBe(true);
    expect(claimed.has('7|audio_file')).toBe(true);
    expect(claimed.has('7|seek_seconds')).toBe(false);
  });

  it('skips media claims when a formInput has no mediaType (defensive)', () => {
    // Bound-only formInput (no nodeId) should not trigger the media path.
    mockTpl = buildTemplate([
      { id: 'tags', label: 'Tags', type: 'textarea', required: true,
        bindNodeId: '42', bindWidgetName: 'tags' },
    ]);
    const objectInfo = {
      TextEncodeAceStepAudio1_5: {
        input: { required: { tags: ['STRING', { multiline: true }] } },
      },
    } satisfies Record<string, Record<string, unknown>>;
    const workflow = {
      nodes: [
        { id: 42, type: 'TextEncodeAceStepAudio1_5', widgets_values: [''] },
      ],
    };
    const claimed = computeFormClaimedWidgets(workflow, objectInfo, 'tpl');
    // Only the bound-prompt path's claim is present; no spurious media claim.
    expect(claimed.has('42|tags')).toBe(true);
    expect(claimed.size).toBe(1);
  });

  it('does not disrupt the bound-prompt path when both kinds coexist', () => {
    // Image upload + bound textarea on different nodes — both should claim
    // independently, and neither should over-claim the other's siblings.
    mockTpl = buildTemplate([
      { id: 'image_0', label: 'Image', type: 'image', required: true,
        nodeId: 3, nodeType: 'LoadImage', mediaType: 'image' },
      { id: 'prompt', label: 'Prompt', type: 'textarea', required: true,
        bindNodeId: '20', bindWidgetName: 'text' },
    ]);
    const objectInfo = {
      LoadImage: {
        input: {
          required: {
            image: ['STRING', {}],
            upload: ['BOOLEAN', {}],
          },
        },
      },
      CLIPTextEncode: {
        input: { required: { text: ['STRING', { multiline: true }] } },
      },
    } satisfies Record<string, Record<string, unknown>>;
    const workflow = {
      nodes: [
        { id: 3, type: 'LoadImage', widgets_values: ['cat.png', true] },
        { id: 20, type: 'CLIPTextEncode', widgets_values: [''] },
      ],
    };
    const claimed = computeFormClaimedWidgets(workflow, objectInfo, 'tpl');
    expect(claimed.has('3|image')).toBe(true);
    expect(claimed.has('3|upload')).toBe(true);
    expect(claimed.has('20|text')).toBe(true);
  });
});
