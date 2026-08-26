// Regression test for the ComfyUI 0.33 "MultiType" widget-alignment bug.
//
// 0.33 changed some node inputs (e.g. LTXVEmptyLatentAudio.frame_rate) from a
// plain primitive ("FLOAT" / "INT") into a MultiType union, which /object_info
// serialises as a comma-joined string ("FLOAT,INT"). Such an input STILL
// occupies a slot in the workflow's positional `widgets_values[]` array. Both
// widget walkers (nodeEmit.getApiWidgetSpecs and rawWidgets.isWidgetSpec) used
// to only recognise single primitives, so they skipped the MultiType input —
// shifting every later widget one slot. Concretely, LTXVEmptyLatentAudio with
// widgets_values [frames_number=97, frame_rate=25, batch_size=1] emitted
// batch_size=25 (frame_rate's value), making the audio latent 25-deep vs the
// video latent's 1, and LTXVConcatAVLatent threw
// "Expected size 1 but got size 25 for tensor number 1 in the list".
//
// The audio flow only breaks when the empty-audio node is used (no reference
// audio provided); providing audio replaces it with LTXVAudioVAEEncode.

import { describe, expect, it } from 'vitest';
import { getApiWidgetSpecs } from '../../src/services/workflow/prompt/nodeEmit.js';
import { isWidgetSpec, widgetNamesFor } from '../../src/services/workflow/rawWidgets/shapes.js';

// Minimal /object_info shaped like ComfyUI 0.33's LTXVEmptyLatentAudio: three
// widget slots (INT, MultiType FLOAT,INT, INT) followed by a VAE socket.
const OBJECT_INFO = {
  LTXVEmptyLatentAudio: {
    input: {
      required: {
        frames_number: ['INT', { default: 97 }],
        frame_rate: ['FLOAT,INT', { default: 25.0 }],   // MultiType union
        batch_size: ['INT', { default: 1 }],
        audio_vae: ['VAE'],                              // socket, not a widget
      },
    },
  },
};

describe('MultiType (comma-joined) widget detection — ComfyUI 0.33', () => {
  it('isWidgetSpec treats a MultiType union with a primitive member as a widget', () => {
    expect(isWidgetSpec(['FLOAT,INT', { default: 25.0 }])).toBe(true);
    // A single primitive still works.
    expect(isWidgetSpec(['INT', { default: 1 }])).toBe(true);
    // A union of pure sockets is NOT a widget.
    expect(isWidgetSpec(['IMAGE,MASK'])).toBe(false);
    // A plain socket is NOT a widget.
    expect(isWidgetSpec(['VAE'])).toBe(false);
  });

  it('widgetNamesFor counts the MultiType input in its true position', () => {
    expect(widgetNamesFor(OBJECT_INFO, 'LTXVEmptyLatentAudio'))
      .toEqual(['frames_number', 'frame_rate', 'batch_size']);
  });

  it('getApiWidgetSpecs includes the MultiType input so later widgets stay aligned', () => {
    const specs = getApiWidgetSpecs(OBJECT_INFO, 'LTXVEmptyLatentAudio');
    // frame_rate must be present (it was previously dropped as a "socket"),
    // and audio_vae (a real socket) must be excluded.
    expect(specs.map(w => w.name)).toEqual(['frames_number', 'frame_rate', 'batch_size']);
    // With frame_rate counted, positional index 2 belongs to batch_size — so a
    // widgets_values array of [97, 25, 1] maps batch_size -> 1 (not 25).
    expect(specs.findIndex(w => w.name === 'batch_size')).toBe(2);
  });
});
