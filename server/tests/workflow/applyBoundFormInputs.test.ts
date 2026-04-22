// applyBoundFormInputs — per-widget injection for the workflow-reading
// form-input path. Unlike `injectUserPrompt`, this writes to exactly the
// (nodeId, widgetName) pairs declared on the form field bindings.

import { describe, expect, it } from 'vitest';
import { applyBoundFormInputs } from '../../src/services/workflow/prompt/inject.js';
import type { ApiPrompt } from '../../src/services/workflow/prompt/index.js';
import type { FlatNode } from '../../src/services/workflow/flatten/index.js';

function makePrompt(): ApiPrompt {
  return {
    '42': {
      class_type: 'TextEncodeAceStepAudio1_5',
      inputs: { tags: 'old-tags', lyrics: 'old-lyrics' },
    },
    '7': {
      class_type: 'CLIPTextEncode',
      inputs: { text: 'old-text', clip: [1, 0] },
    },
  };
}

describe('applyBoundFormInputs', () => {
  const emptyNodes = new Map<string, FlatNode>();

  it('writes each binding to the named widget and returns the covered set', () => {
    const prompt = makePrompt();
    const covered = applyBoundFormInputs(prompt, emptyNodes, [
      { bindNodeId: '42', bindWidgetName: 'tags', value: 'new-tags' },
      { bindNodeId: '42', bindWidgetName: 'lyrics', value: 'new-lyrics' },
    ]);
    expect(prompt['42'].inputs.tags).toBe('new-tags');
    expect(prompt['42'].inputs.lyrics).toBe('new-lyrics');
    expect(covered).toEqual(new Set(['42|tags', '42|lyrics']));
  });

  it('preserves the wire-guard: upstream [nodeId, slot] arrays are not overwritten', () => {
    const prompt: ApiPrompt = {
      '5': {
        class_type: 'CLIPTextEncode',
        // `text` is wired from an upstream node — the bound path must
        // leave that route intact (LTX-2.3 Gemma expansion etc.).
        inputs: { text: ['9', 0], clip: [1, 0] },
      },
    };
    const covered = applyBoundFormInputs(prompt, emptyNodes, [
      { bindNodeId: '5', bindWidgetName: 'text', value: 'should-not-land' },
    ]);
    expect(prompt['5'].inputs.text).toEqual(['9', 0]);
    // Still marked as covered so the legacy fan-out skips this key.
    expect(covered.has('5|text')).toBe(true);
  });

  it('skips empty-string values so blank fields keep the workflow default', () => {
    const prompt = makePrompt();
    const covered = applyBoundFormInputs(prompt, emptyNodes, [
      { bindNodeId: '42', bindWidgetName: 'tags', value: '' },
    ]);
    expect(prompt['42'].inputs.tags).toBe('old-tags');
    expect(covered.size).toBe(0);
  });

  it('ignores bindings whose node is missing from the prompt', () => {
    const prompt = makePrompt();
    const covered = applyBoundFormInputs(prompt, emptyNodes, [
      { bindNodeId: '999', bindWidgetName: 'text', value: 'x' },
    ]);
    expect(covered.size).toBe(0);
  });

  it('routes independently to separate nodes', () => {
    const prompt = makePrompt();
    const covered = applyBoundFormInputs(prompt, emptyNodes, [
      { bindNodeId: '42', bindWidgetName: 'tags', value: 'A' },
      { bindNodeId: '7', bindWidgetName: 'text', value: 'B' },
    ]);
    expect(prompt['42'].inputs.tags).toBe('A');
    expect(prompt['7'].inputs.text).toBe('B');
    // `7.text` had a literal default; wire-guard only kicks in for arrays.
    expect(covered).toEqual(new Set(['42|tags', '7|text']));
  });
});
