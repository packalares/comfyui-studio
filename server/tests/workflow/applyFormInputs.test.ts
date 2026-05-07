import { describe, expect, it } from 'vitest';
import { applyFormInputs } from '../../src/services/workflow/prompt/inject.js';
import type { FormInputBinding } from '../../src/contracts/workflow.contract.js';
import type { ApiPrompt } from '../../src/services/workflow/prompt/types.js';

function makePrompt(nodeId: number, classType: string, inputs: Record<string, unknown>): ApiPrompt {
  return {
    [String(nodeId)]: {
      class_type: classType,
      inputs: { ...inputs },
    },
  } as unknown as ApiPrompt;
}

describe('applyFormInputs — video binding routes by nodeType', () => {
  it('writes mainline LoadVideo upload onto inputs.file', () => {
    const prompt = makePrompt(679, 'LoadVideo', { file: 'man_in_the_rain.mp4' });
    const bindings: FormInputBinding[] = [
      { id: 'video_0', nodeId: 679, nodeType: 'LoadVideo', mediaType: 'video' },
    ];
    applyFormInputs(prompt, bindings, { video_0: 'chain_52_clean.mp4' });

    expect(prompt['679'].inputs.file).toBe('chain_52_clean.mp4');
    expect(prompt['679'].inputs.upload).toBe('video');
    // The legacy `video` key MUST NOT be set on a mainline LoadVideo entry —
    // ComfyUI's validator only reads `file` here.
    expect(prompt['679'].inputs.video).toBeUndefined();
  });

  it('writes VHS_LoadVideo upload onto inputs.video (legacy)', () => {
    const prompt = makePrompt(5, 'VHS_LoadVideo', { video: 'old.mp4', force_rate: 0 });
    const bindings: FormInputBinding[] = [
      { id: 'video_0', nodeId: 5, nodeType: 'VHS_LoadVideo', mediaType: 'video' },
    ];
    applyFormInputs(prompt, bindings, { video_0: 'new.mp4' });

    expect(prompt['5'].inputs.video).toBe('new.mp4');
    expect(prompt['5'].inputs.upload).toBe('video');
    // VHS_LoadVideo has no `file` input — must not be added.
    expect(prompt['5'].inputs.file).toBeUndefined();
    // Sibling config widgets stay intact.
    expect(prompt['5'].inputs.force_rate).toBe(0);
  });

  it('falls back to inputs.video when nodeType is unknown', () => {
    const prompt = makePrompt(7, 'CustomVideoLoader', { video: 'x.mp4' });
    const bindings: FormInputBinding[] = [
      { id: 'video_0', nodeId: 7, nodeType: 'CustomVideoLoader', mediaType: 'video' },
    ];
    applyFormInputs(prompt, bindings, { video_0: 'y.mp4' });

    expect(prompt['7'].inputs.video).toBe('y.mp4');
  });
});
