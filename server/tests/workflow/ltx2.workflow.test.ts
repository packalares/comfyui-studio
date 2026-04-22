// End-to-end fidelity test for the modern ComfyUI workflow format.
//
// Target: ComfyUI 0.3.51+'s canonical output for `video_ltx2_3_i2v.json`.
// We load the source workflow + the ground-truth API prompt (captured from
// native ComfyUI's "Export (API)" / live /api/prompt submission) and assert
// our `workflowToApiPrompt` produces a byte-equivalent API prompt.
//
// Covers: subgraph expansion (compound IDs), V3 widget dotted-key emission,
// Primitive* nodes as real emitted nodes, LoadImage pass-through.
//
// When this test passes, the LTX2 generation path works end-to-end.

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

/**
 * Normalise volatile + UI-only fields before deep-equal. We compare the
 * structural conversion (node set, class types, wire graph, widget values)
 * not per-run randomness:
 *   - noise_seed / seed: random every submit. Strip.
 *   - LoadImage.image: user upload filename. Canonicalise.
 *   - PreviewAny hidden UI widgets (previewMode / preview_markdown /
 *     preview_text): not in /api/object_info's `required` — emitted by
 *     ComfyUI's frontend as UI state. Out of scope for this fidelity test.
 */
function normalise(p: Record<string, { class_type: string; inputs: Record<string, unknown>; _meta?: unknown }>): typeof p {
  const out: typeof p = {};
  for (const [id, node] of Object.entries(p)) {
    const inputs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node.inputs || {})) {
      if (k === 'noise_seed' || k === 'seed') { inputs[k] = 0; continue; }
      if (node.class_type === 'LoadImage' && k === 'image') { inputs[k] = '<upload>'; continue; }
      if (node.class_type === 'PreviewAny' && (k === 'previewMode' || k === 'preview_markdown' || k === 'preview_text')) continue;
      inputs[k] = v;
    }
    out[id] = { ...node, inputs };
  }
  return out;
}

describe('LTX2 i2v workflow → API prompt fidelity', () => {
  beforeAll(() => {
    resetObjectInfoCache();
    seedObjectInfoCache(
      readJson('ltx2_i2v.objectInfo.json') as Record<string, Record<string, unknown>>,
    );
  });

  it('subgraph workflow emits the compound-ID API prompt ComfyUI native produces', async () => {
    const wf = readJson('ltx2_i2v.workflow.json');
    const target = readJson('ltx2_i2v.prompt.json');

    const out = await workflowToApiPrompt(wf, { prompt: '' });

    // Node-set parity: same compound IDs produced, nothing extra, nothing missing.
    expect(Object.keys(out).sort()).toEqual(Object.keys(target).sort());

    // Class types per node match.
    for (const id of Object.keys(target)) {
      expect(
        (out as Record<string, { class_type: string }>)[id].class_type,
      ).toBe((target as Record<string, { class_type: string }>)[id].class_type);
    }

    // Inputs parity — byte-equivalence after normalising volatile + UI-only fields.
    expect(normalise(out as Parameters<typeof normalise>[0]))
      .toEqual(normalise(target as Parameters<typeof normalise>[0]));
  });
});
