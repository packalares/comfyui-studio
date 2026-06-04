/**
 * Run a Video Scenes (Director) pass through ComfyUI.
 *
 * Flow:
 *   1) build the workflow JSON via buildScenesWorkflow
 *   2) POST it to /api/prompt — get prompt_id
 *   3) await trackComfyPrompt(prompt_id) — WS-driven (see comfyJobBridge.ts)
 *      Resolves on `execution_success`/`execution_complete`, rejects on
 *      `execution_cancelled`/`execution_interrupted`/`execution_error`,
 *      or caller-side abort/timeout.
 *   4) fetch /history/{prompt_id} exactly once
 *   5) extract the OMNI_AUDIO_VideoScenes `scenes` UI string
 *   6) JSON.parse it into the typed DirectorShot[] shape
 *
 * Previously this module polled /history every 3 s in a loop; the loop never
 * caught cancellations (the entry just stayed null) so a cancelled-in-canvas
 * run would hang for the full timeout. The WS bridge fixes both halves —
 * faster happy path, and immediate failure on cancel/error.
 */
import { logger } from '../../lib/logger.js';
import { ComfyUIHttpError, getHistoryForPrompt, submitPrompt } from '../comfyui/api.js';
import {
  buildScenesWorkflow,
  type ScenesWorkflowParams,
  type ComfyPromptGraph,
} from './buildScenesWorkflow.js';
import { trackComfyPrompt, getBridgeClientId } from './comfyJobBridge.js';

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export interface ScenesRunOptions {
  signal?: AbortSignal;
  /** Hard upper bound on total run time. Director is slow — ~5 min/song.
   *  Acts as a safety net if the WS misses the terminal event (e.g. ComfyUI
   *  died mid-run). Default 30 min. */
  timeoutMs?: number;
}

/** One shot as the Director Python node emits it.
 *  Field names are snake_case because this is the verbatim JSON shape. */
export interface DirectorShot {
  scene_id: number;
  start: number;       // seconds
  end: number;         // seconds
  chunk_idx: number;
  description: string;
  image_prompt: string;
  video_prompt: string;
  key_visual: string;
  treatment_snapshot: string;
}

export interface ScenesRunResult {
  promptId: string;
  shots: DirectorShot[];
  /** Final rolling treatment after the last chunk — useful for debugging /
   *  surfacing the director's bible in the UI. */
  treatment: string;
  /** Raw scenes JSON string as the node emitted it. */
  rawJson: string;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 min safety net — Director on a 4 min song takes ~5 min
const SCENES_CLASS_TYPE = 'OMNI_AUDIO_VideoScenes';

export async function scenesViaComfyUI(
  params: ScenesWorkflowParams,
  opts: ScenesRunOptions = {},
): Promise<ScenesRunResult> {
  const wf = buildScenesWorkflow(params);
  const scenesNodeId = findNodeIdByClass(wf, SCENES_CLASS_TYPE);

  // 1) Queue. submitPrompt throws via ComfyUIHttpError on validation errors
  //    (node_errors → HTTP 400). The body has the actual reason; surface it.
  let promptId: string;
  try {
    const queued = await submitPrompt(wf as unknown as Record<string, unknown>, {
      clientId: getBridgeClientId(),
    });
    promptId = queued.prompt_id;
  } catch (err) {
    if (err instanceof ComfyUIHttpError) {
      throw new Error(
        `ComfyUI /prompt rejected (${err.status} at ${err.path}): ${err.body.slice(0, 600)}`,
      );
    }
    throw err;
  }
  if (!promptId) {
    throw new Error('ComfyUI accepted the prompt but returned no prompt_id');
  }
  logger.info?.(`[videoboard.scenes] submitted prompt ${promptId}`);

  // 2) Wait for a terminal WS event (success / cancelled / error / interrupted)
  //    or the safety timeout. trackComfyPrompt throws with a typed error on
  //    cancel/error — let it propagate to the caller (route handler maps it
  //    to the videoboard_jobs row + project status).
  await trackComfyPrompt(promptId, {
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: opts.signal,
  });

  // 3) Now fetch /history exactly once for the output payload.
  const entry = await getHistoryForPrompt(promptId);
  if (!entry) {
    throw new Error(
      `ComfyUI reported success for ${promptId} but /history returned null. `
      + `Did the prompt get evicted before we could read it?`,
    );
  }

  // 4) Extract + parse.
  const { scenesRaw, treatmentRaw } = extractSceneStrings(entry, scenesNodeId, promptId);
  let shots: DirectorShot[];
  try {
    const parsed = JSON.parse(scenesRaw);
    if (!Array.isArray(parsed)) {
      throw new Error(`expected array, got ${typeof parsed}`);
    }
    shots = parsed as DirectorShot[];
  } catch (err) {
    throw new Error(
      `Scenes JSON parse failed for ${promptId}: ${(err as Error).message}; `
      + `first 200 chars: ${scenesRaw.slice(0, 200)}`,
    );
  }
  return { promptId, shots, treatment: treatmentRaw, rawJson: scenesRaw };
}

// ---------------------------------------------------------------------------
// Internals (output-shape parsing — unchanged from the polling-era code)
// ---------------------------------------------------------------------------

interface HistoryEntry {
  prompt?: unknown;
  outputs?: Record<string, Record<string, unknown>>;
  status?: {
    status_str?: 'success' | 'error' | string;
    completed?: boolean;
    messages?: unknown[];
  };
}

function findNodeIdByClass(prompt: ComfyPromptGraph, classType: string): string {
  for (const [id, node] of Object.entries(prompt)) {
    if (node.class_type === classType) return id;
  }
  throw new Error(
    `Workflow contains no node with class_type "${classType}" — builder mismatch.`,
  );
}

function extractSceneStrings(
  entry: HistoryEntry,
  nodeId: string,
  promptId: string,
): { scenesRaw: string; treatmentRaw: string } {
  const nodeOutput = entry.outputs?.[nodeId];
  if (!nodeOutput) {
    throw new Error(
      `Scenes node ${nodeId} produced no output for prompt ${promptId}. `
      + `Outputs present for nodes: ${Object.keys(entry.outputs ?? {}).join(',') || '<none>'}`,
    );
  }
  const scenesRaw = pickFirstString(nodeOutput, 'scenes', nodeId, promptId);
  // treatment is informational — empty fallback is fine if the node didn't
  // publish it (older Python versions). Don't fail the run on a missing one.
  const treatmentField = nodeOutput.treatment;
  const treatmentRaw =
    Array.isArray(treatmentField) && typeof treatmentField[0] === 'string'
      ? (treatmentField[0])
      : '';
  return { scenesRaw, treatmentRaw };
}

function pickFirstString(
  nodeOutput: Record<string, unknown>,
  key: string,
  nodeId: string,
  promptId: string,
): string {
  const field = nodeOutput[key];
  if (!Array.isArray(field) || field.length === 0) {
    throw new Error(
      `Scenes output missing '${key}' UI key for prompt ${promptId}. `
      + `Saw keys: ${Object.keys(nodeOutput).join(',') || '<none>'}. `
      + `Does nodes_video_scenes.py wrap its return as { ui: { ${key}: [...] }, result: (...) }?`,
    );
  }
  const raw = field[0];
  if (typeof raw !== 'string') {
    throw new Error(`Scenes '${key}' field is not a string (got ${typeof raw}, node ${nodeId})`);
  }
  return raw;
}
