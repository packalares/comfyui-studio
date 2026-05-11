// Shared helper: convert a litegraph workflow to a stable (seed-zeroed)
// API prompt. Extracted so both the /template-api-prompt route and
// buildTemplateBundle can call the same logic without duplication.

import { workflowToApiPrompt } from './prompt/index.js';
import type { ApiPrompt } from './prompt/types.js';

/**
 * Build an API-prompt from a litegraph workflow JSON with seeds zeroed so
 * two successive calls return identical output. Mirrors the logic in the
 * /template-api-prompt route exactly.
 */
export async function buildStableApiPrompt(
  workflow: Record<string, unknown>,
): Promise<ApiPrompt> {
  const apiPrompt = await workflowToApiPrompt(workflow, {}, []);
  for (const entry of Object.values(apiPrompt)) {
    if (entry.class_type === 'KSampler' && 'seed' in entry.inputs) {
      entry.inputs.seed = 0;
    }
    if (entry.class_type === 'RandomNoise' && 'noise_seed' in entry.inputs) {
      entry.inputs.noise_seed = 0;
    }
  }
  return apiPrompt;
}
