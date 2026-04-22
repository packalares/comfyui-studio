// Phase C — user edits in Primitive-derived form fields route back to the
// correct Primitive node in the API prompt.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it, beforeAll } from 'vitest';
import { workflowToApiPrompt } from '../../src/services/workflow/index.js';
import {
  resetObjectInfoCache,
  seedObjectInfoCache,
} from '../../src/services/workflow/objectInfo.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, '..', 'fixtures', 'workflows');

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(FIX, rel), 'utf8'));
}

describe('Primitive-derived form-field overrides', () => {
  beforeAll(() => {
    resetObjectInfoCache();
    seedObjectInfoCache(
      readJson('ltx2_i2v.objectInfo.json') as Record<string, Record<string, unknown>>,
    );
  });

  it('user prompt overrides the Prompt-titled PrimitiveStringMultiline', async () => {
    const wf = readJson('ltx2_i2v.workflow.json');
    const out = await workflowToApiPrompt(wf, { prompt: 'a custom prompt the user typed' });
    const primitive = (out as Record<string, { class_type: string; inputs: Record<string, unknown> }>)['267:266'];
    expect(primitive.class_type).toBe('PrimitiveStringMultiline');
    expect(primitive.inputs.value).toBe('a custom prompt the user typed');
  });

  it('empty user prompt leaves the workflow default in place', async () => {
    const wf = readJson('ltx2_i2v.workflow.json');
    const out = await workflowToApiPrompt(wf, { prompt: '' });
    const primitive = (out as Record<string, { inputs: Record<string, unknown> }>)['267:266'];
    // The original default lives in the workflow — must be preserved.
    expect(typeof primitive.inputs.value).toBe('string');
    expect((primitive.inputs.value as string).startsWith('Egyptian royal')).toBe(true);
  });

  it('primitive:<nodeId> overrides a specific PrimitiveInt value', async () => {
    const wf = readJson('ltx2_i2v.workflow.json');
    // Width Primitive lives at inner id 257 → compound id 267:257.
    const out = await workflowToApiPrompt(wf, {
      prompt: '',
      'primitive:257': 1920,
    });
    const widthNode = (out as Record<string, { inputs: Record<string, unknown> }>)['267:257'];
    expect(widthNode.inputs.value).toBe(1920);
    // Unrelated primitives stay at their defaults.
    const heightNode = (out as Record<string, { inputs: Record<string, unknown> }>)['267:258'];
    expect(heightNode.inputs.value).toBe(720);
  });

  it('primitive:<nodeId> coerces numbers passed as strings', async () => {
    const wf = readJson('ltx2_i2v.workflow.json');
    const out = await workflowToApiPrompt(wf, {
      prompt: '',
      'primitive:257': '1920', // as might arrive from a form field
    });
    const widthNode = (out as Record<string, { inputs: Record<string, unknown> }>)['267:257'];
    expect(widthNode.inputs.value).toBe(1920);
  });

  it('primitive:<nodeId> coerces booleans for PrimitiveBoolean', async () => {
    const wf = readJson('ltx2_i2v.workflow.json');
    const out = await workflowToApiPrompt(wf, {
      prompt: '',
      'primitive:201': true, // "Switch to Text to Video?"
    });
    const boolNode = (out as Record<string, { inputs: Record<string, unknown> }>)['267:201'];
    expect(boolNode.inputs.value).toBe(true);
  });

  it('id-specific override beats the prompt-title mapping', async () => {
    const wf = readJson('ltx2_i2v.workflow.json');
    // Prompt primitive is at inner id 266 → both `prompt` and `primitive:266`
    // could reasonably target it. `primitive:266` must win for precise edits.
    const out = await workflowToApiPrompt(wf, {
      prompt: 'generic',
      'primitive:266': 'specific',
    });
    const promptNode = (out as Record<string, { inputs: Record<string, unknown> }>)['267:266'];
    expect(promptNode.inputs.value).toBe('specific');
  });
});
