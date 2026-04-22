// Wire-guard regression test for injectUserPrompt.
//
// Modern subgraph workflows (LTX-2.3, Wan, Hunyuan, ...) route the user's
// prompt through intermediate nodes — TextGenerateLTX2Prompt runs Gemma
// expansion, ClipTextEncodeAdvanced runs token merging, etc. — before the
// text reaches CLIPTextEncode. The routing is expressed as a wire: the
// `text` input on CLIPTextEncode is `[upstream_node_id, slot]`, not a
// literal string.
//
// An earlier injectUserPrompt would blindly overwrite any prompt-role
// widget with the user's text, destroying those wires. For LTX-2.3 that
// bypassed Gemma and degraded image-to-video conditioning to "use image
// as first frame, invent motion from scratch". The wire-guard keeps the
// wire intact — the user's prompt flows through the canonical Primitive
// handoff instead.

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

describe('injectUserPrompt wire guard', () => {
  beforeAll(() => {
    resetObjectInfoCache();
    seedObjectInfoCache(
      readJson('ltx2_i2v.objectInfo.json') as Record<string, Record<string, unknown>>,
    );
  });

  it('leaves CLIPTextEncode.text as a wire ref when upstream routes the prompt', async () => {
    const wf = readJson('ltx2_i2v.workflow.json');
    const out = await workflowToApiPrompt(wf, { prompt: 'Egyptian royal in blue-and-gold' });
    const clipPos = (out as Record<string, { class_type: string; inputs: Record<string, unknown> }>)['267:240'];
    expect(clipPos.class_type).toBe('CLIPTextEncode');
    // Must remain a wire reference pointing at TextGenerateLTX2Prompt (267:274).
    expect(Array.isArray(clipPos.inputs.text)).toBe(true);
    const wire = clipPos.inputs.text as unknown[];
    expect(wire[0]).toBe('267:274');
  });

  it('routes the user prompt into the Prompt PrimitiveStringMultiline (the Gemma input source)', async () => {
    const wf = readJson('ltx2_i2v.workflow.json');
    const out = await workflowToApiPrompt(wf, { prompt: 'a futuristic robot chef' });
    const primPrompt = (out as Record<string, { class_type: string; inputs: Record<string, unknown> }>)['267:266'];
    expect(primPrompt.class_type).toBe('PrimitiveStringMultiline');
    expect(primPrompt.inputs.value).toBe('a futuristic robot chef');
  });

  it('still fills a LITERAL text input on a classic flat CLIPTextEncode workflow', async () => {
    // Flat workflow where the positive CLIPTextEncode has NO upstream wire
    // on `text` — the prompt should land as a literal string here (the
    // back-compat path used by every pre-LTX workflow).
    seedObjectInfoCache({
      CLIPTextEncode: {
        input: {
          required: {
            text: ['STRING', { multiline: true }],
            clip: ['CLIP'],
          },
        },
        output: ['CONDITIONING'],
      },
      CheckpointLoaderSimple: {
        input: { required: { ckpt_name: [['sd-xl.safetensors']] } },
        output: ['MODEL', 'CLIP', 'VAE'],
      },
    });
    const wf = {
      nodes: [
        {
          id: 1, type: 'CheckpointLoaderSimple', inputs: [],
          widgets_values: ['sd-xl.safetensors'],
        },
        {
          id: 2, type: 'CLIPTextEncode', title: 'Positive',
          inputs: [{ name: 'clip', link: 1, type: 'CLIP' }],
          widgets_values: [''],
        },
      ],
      links: [
        [1, 1, 1, 2, 0, 'CLIP'],
      ],
    };
    const out = await workflowToApiPrompt(wf, { prompt: 'a mountain landscape' });
    const clipPos = (out as Record<string, { inputs: Record<string, unknown> }>)['2'];
    expect(clipPos.inputs.text).toBe('a mountain landscape');
  });

  it('does not overwrite a negative-prompt-titled node even if its text is a literal', async () => {
    seedObjectInfoCache({
      CLIPTextEncode: {
        input: {
          required: {
            text: ['STRING', { multiline: true }],
            clip: ['CLIP'],
          },
        },
        output: ['CONDITIONING'],
      },
    });
    const wf = {
      nodes: [
        {
          id: 7, type: 'CLIPTextEncode', title: 'Negative Prompt',
          inputs: [],
          widgets_values: ['ugly, blurry'],
        },
      ],
      links: [],
    };
    const out = await workflowToApiPrompt(wf, { prompt: 'SHOULD NOT LAND HERE' });
    const neg = (out as Record<string, { inputs: Record<string, unknown> }>)['7'];
    expect(neg.inputs.text).toBe('ugly, blurry');
  });
});
