// Tests for the PreviewAny probe injector. The key behaviour to nail
// down is the "switch-gated source" rule — without it, a TextGenerate*
// node hanging off a `ComfySwitchNode.on_true` slot would get probed
// (and thus executed) every time, even when the user has the enhance
// toggle switched off.

import { describe, expect, it } from 'vitest';
import {
  injectEnhancerProbes,
  probeIdFor,
  sourceIdFromProbeKey,
} from '../../src/services/workflow/prompt/enhancerProbe.js';
import type { ApiPrompt } from '../../src/services/workflow/prompt/index.js';

describe('enhancerProbe', () => {
  it('round-trips probe ids', () => {
    const id = probeIdFor('424:444');
    expect(id).toBe('__studio_enhanced_424:444');
    expect(sourceIdFromProbeKey(id)).toBe('424:444');
    expect(sourceIdFromProbeKey('424:444')).toBeNull();
  });

  it('injects a probe for every TextGenerate* with a real consumer', () => {
    const prompt: ApiPrompt = {
      '424:444': { class_type: 'TextGenerateLTX2Prompt', inputs: { clip: ['440', 1] } },
      '500':     { class_type: 'CLIPTextEncode',         inputs: { text: ['424:444', 0] } },
    };
    const added = injectEnhancerProbes(prompt);
    expect(added).toEqual([{ sourceNodeId: '424:444', probeId: '__studio_enhanced_424:444' }]);
    expect(prompt['__studio_enhanced_424:444']?.class_type).toBe('PreviewAny');
    expect(prompt['__studio_enhanced_424:444']?.inputs?.source).toEqual(['424:444', 0]);
  });

  it('skips probing when the only consumer is a switch gated off (static false)', () => {
    const prompt: ApiPrompt = {
      '424:401': { class_type: 'PrimitiveStringMultiline', inputs: { value: 'raw' } },
      '424:444': { class_type: 'TextGenerateLTX2Prompt',   inputs: { clip: ['440', 1] } },
      '424:445': { class_type: 'PrimitiveBoolean',         inputs: { value: false } },
      '424:413': {
        class_type: 'ComfySwitchNode',
        inputs: { on_false: ['424:401', 0], on_true: ['424:444', 0], switch: ['424:445', 0] },
      },
    };
    const added = injectEnhancerProbes(prompt);
    expect(added).toEqual([]);
    expect(prompt['__studio_enhanced_424:444']).toBeUndefined();
  });

  it('injects when the gating boolean is statically true', () => {
    const prompt: ApiPrompt = {
      '424:401': { class_type: 'PrimitiveStringMultiline', inputs: { value: 'raw' } },
      '424:444': { class_type: 'TextGenerateLTX2Prompt',   inputs: { clip: ['440', 1] } },
      '424:445': { class_type: 'PrimitiveBoolean',         inputs: { value: true } },
      '424:413': {
        class_type: 'ComfySwitchNode',
        inputs: { on_false: ['424:401', 0], on_true: ['424:444', 0], switch: ['424:445', 0] },
      },
    };
    const added = injectEnhancerProbes(prompt);
    expect(added.map(a => a.sourceNodeId)).toEqual(['424:444']);
  });

  it('injects conservatively when the gating boolean cannot be resolved statically', () => {
    // Switch's `switch` is wired to a non-Primitive node (e.g. another
    // logic node) — we can't tell statically which branch executes, so
    // the probe still fires. The alternative would be silently stripping
    // a probe the user expected; conservatism wins.
    const prompt: ApiPrompt = {
      '300':     { class_type: 'SomeBooleanLogicNode', inputs: { a: true, b: false } },
      '424:401': { class_type: 'PrimitiveStringMultiline', inputs: { value: 'raw' } },
      '424:444': { class_type: 'TextGenerateLTX2Prompt',   inputs: { clip: ['440', 1] } },
      '424:413': {
        class_type: 'ComfySwitchNode',
        inputs: { on_false: ['424:401', 0], on_true: ['424:444', 0], switch: ['300', 0] },
      },
    };
    const added = injectEnhancerProbes(prompt);
    expect(added.map(a => a.sourceNodeId)).toEqual(['424:444']);
  });

  it('skips probing when the source has no consumers at all', () => {
    const prompt: ApiPrompt = {
      '424:444': { class_type: 'TextGenerateLTX2Prompt', inputs: { clip: ['440', 1] } },
    };
    const added = injectEnhancerProbes(prompt);
    expect(added).toEqual([]);
  });

  it('ignores its own probe nodes when assessing reachability', () => {
    // A re-injection on the same prompt should be a no-op and never count
    // the existing probe as a "real" consumer of itself.
    const prompt: ApiPrompt = {
      '424:444': { class_type: 'TextGenerateLTX2Prompt', inputs: { clip: ['440', 1] } },
      '500':     { class_type: 'CLIPTextEncode',         inputs: { text: ['424:444', 0] } },
    };
    injectEnhancerProbes(prompt);
    const added = injectEnhancerProbes(prompt);
    expect(added).toEqual([]);
    expect(prompt['__studio_enhanced_424:444']).toBeDefined();
  });
});
