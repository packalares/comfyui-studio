// Edge-case emission tests — ported behaviours from SethRobinson's
// workflow_converter.py that close small gaps in our pipeline:
//   - Inline COMBO case normalisation ("True" -> "true")
//   - Dict-form widgets_values (rgthree Power LoRA Loader style)
//   - V3 sub-input schema-default backfill when widgets_values is short

import { describe, expect, it, beforeAll } from 'vitest';
import { workflowToApiPrompt } from '../../src/services/workflow/index.js';
import {
  resetObjectInfoCache,
  seedObjectInfoCache,
} from '../../src/services/workflow/objectInfo.js';

describe('emitter edge cases', () => {
  beforeAll(() => {
    resetObjectInfoCache();
  });

  it('case-normalises inline COMBO values against the allowed options', async () => {
    seedObjectInfoCache({
      MyComboNode: {
        input: {
          required: {
            mode: [['low', 'medium', 'high']],
          },
        },
      },
    });
    const wf = {
      nodes: [
        {
          id: 1,
          type: 'MyComboNode',
          widgets_values: ['HIGH'], // wrong case
          inputs: [],
        },
      ],
      links: [],
    };
    const out = await workflowToApiPrompt(wf, {});
    expect((out as Record<string, { inputs: { mode: string } }>)['1'].inputs.mode)
      .toBe('high');
  });

  it('leaves inline COMBO values unchanged when they match an allowed option exactly', async () => {
    seedObjectInfoCache({
      MyComboNode: {
        input: { required: { mode: [['low', 'medium', 'high']] } },
      },
    });
    const wf = {
      nodes: [{ id: 1, type: 'MyComboNode', widgets_values: ['medium'], inputs: [] }],
      links: [],
    };
    const out = await workflowToApiPrompt(wf, {});
    expect((out as Record<string, { inputs: { mode: string } }>)['1'].inputs.mode)
      .toBe('medium');
  });

  it('leaves unknown-case-but-no-match COMBO values as-is (ComfyUI will reject downstream)', async () => {
    seedObjectInfoCache({
      MyComboNode: {
        input: { required: { mode: [['low', 'medium', 'high']] } },
      },
    });
    const wf = {
      nodes: [{ id: 1, type: 'MyComboNode', widgets_values: ['extreme'], inputs: [] }],
      links: [],
    };
    const out = await workflowToApiPrompt(wf, {});
    expect((out as Record<string, { inputs: { mode: string } }>)['1'].inputs.mode)
      .toBe('extreme');
  });

  it('handles dict-form widgets_values (custom-node style)', async () => {
    // rgthree/Power-LoRA-Loader and a few other custom packs serialise
    // widgets_values as an object keyed by widget name. Our emitter looks
    // the value up by name in this case, identical to the list-form path.
    seedObjectInfoCache({
      DictWidgetsNode: {
        input: {
          required: {
            name: ['STRING', { default: '' }],
            strength: ['FLOAT', { default: 1 }],
          },
        },
      },
    });
    const wf = {
      nodes: [
        {
          id: 1,
          type: 'DictWidgetsNode',
          widgets_values: { name: 'hello', strength: 0.5 },
          inputs: [],
        },
      ],
      links: [],
    };
    const out = await workflowToApiPrompt(wf, {});
    const entry = (out as Record<string, { inputs: Record<string, unknown> }>)['1'];
    expect(entry.inputs.name).toBe('hello');
    expect(entry.inputs.strength).toBe(0.5);
  });

  it('backfills a missing widget from its schema default', async () => {
    seedObjectInfoCache({
      DefaultedNode: {
        input: {
          required: {
            width: ['INT', { default: 512 }],
            height: ['INT', { default: 768 }],
          },
        },
      },
    });
    const wf = {
      nodes: [
        {
          id: 1,
          type: 'DefaultedNode',
          widgets_values: [1024], // only one value; height should fall back to default
          inputs: [],
        },
      ],
      links: [],
    };
    const out = await workflowToApiPrompt(wf, {});
    const entry = (out as Record<string, { inputs: Record<string, unknown> }>)['1'];
    expect(entry.inputs.width).toBe(1024);
    expect(entry.inputs.height).toBe(768); // backfilled
  });
});
