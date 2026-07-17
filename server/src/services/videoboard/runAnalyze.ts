/**
 * Run a full Music Analyze pass through ComfyUI:
 *   1) build the workflow JSON via buildAnalyzeWorkflow
 *   2) POST it to /api/prompt
 *   3) poll /api/history/<prompt_id> until the run completes (success or error)
 *   4) extract OMNI_AUDIO_Analyze's `analysis_json` string from the history outputs
 *   5) JSON.parse it into the typed AnalysisJson shape
 *
 * Why a UI key, not the wire output: ComfyUI's /history endpoint only surfaces
 * what nodes publish into their `ui` dict — RETURN_TYPES values flow to wires
 * but never appear in the history JSON. The Analyze node wraps its return as
 * `{ ui: { analysis: [analysis_json] }, result: (...) }` so the JSON shows up
 * here AND downstream nodes (Video Scenes) still receive it via wire.
 */
import type { Analysis } from '../../contracts/videoboard.js';
import { logger } from '../../lib/logger.js';
import { ComfyUIHttpError, getHistoryForPrompt, submitPrompt } from '../comfyui/api.js';
import {
  buildAnalyzeWorkflow,
  type AnalyzeWorkflowParams,
  type ComfyPromptGraph,
} from './buildAnalyzeWorkflow.js';

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export interface AnalyzeRunOptions {
  /** Cancels the wait loop early (e.g. user removed audio mid-analyze). */
  signal?: AbortSignal;
  /** Hard upper bound on total run time. Default 15 min. */
  timeoutMs?: number;
  /** /history poll cadence. Default 2 s. */
  pollIntervalMs?: number;
}

export interface AnalyzeRunResult {
  promptId: string;
  analysis: Analysis;
  /** The raw analysis_json string as the node emitted it (pre-JSON.parse). */
  rawJson: string;
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 2000;
const ANALYZE_CLASS_TYPE = 'OMNI_AUDIO_Analyze';

export async function analyzeViaComfyUI(
  params: AnalyzeWorkflowParams,
  opts: AnalyzeRunOptions = {},
): Promise<AnalyzeRunResult> {
  const wf = buildAnalyzeWorkflow(params);
  const analyzeNodeId = findNodeIdByClass(wf, ANALYZE_CLASS_TYPE);

  // 1) Queue. submitPrompt throws via ComfyUIHttpError on validation errors
  // (node_errors → HTTP 400). The body has the actual reason; surface it.
  let promptId: string;
  try {
    const queued = await submitPrompt(wf as unknown as Record<string, unknown>);
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
  logger.info?.(
    `[videoboard.analyze] submitted prompt ${promptId} for identifier=${params.identifier}`,
  );

  // 2) Wait for completion.
  const entry = await waitForCompletion(promptId, {
    signal: opts.signal,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    pollIntervalMs: opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
  });

  // 3) Extract + parse.
  const rawJson = extractAnalysisJson(entry, analyzeNodeId, promptId);
  let analysis: Analysis;
  try {
    analysis = JSON.parse(rawJson) as Analysis;
  } catch (err) {
    throw new Error(
      `Analyze JSON parse failed for ${promptId}: ${(err as Error).message}; `
      + `first 200 chars: ${rawJson.slice(0, 200)}`,
    );
  }
  return { promptId, analysis, rawJson };
}

// ---------------------------------------------------------------------------
// Internals
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

async function waitForCompletion(
  promptId: string,
  opts: { signal?: AbortSignal; timeoutMs: number; pollIntervalMs: number },
): Promise<HistoryEntry> {
  const startMs = Date.now();
  while (true) {
    if (opts.signal?.aborted) {
      throw new Error(`Analyze cancelled by caller (prompt ${promptId})`);
    }
    if (Date.now() - startMs > opts.timeoutMs) {
      throw new Error(
        `ComfyUI analyze for prompt ${promptId} timed out after ${opts.timeoutMs}ms`,
      );
    }

    let entry: HistoryEntry | null = null;
    try {
      entry = (await getHistoryForPrompt(promptId)) as HistoryEntry | null;
    } catch (err) {
      // Transient /history failures (e.g. ComfyUI briefly busy) — log + retry.
      logger.warn?.(
        `[videoboard.analyze] /history poll for ${promptId} failed: ${(err as Error).message}`,
      );
    }

    if (entry && isComplete(entry)) {
      if (entry.status?.status_str === 'error') {
        throw new Error(
          `ComfyUI execution error for ${promptId}: `
          + summarizeMessages(entry.status.messages),
        );
      }
      return entry;
    }
    await sleep(opts.pollIntervalMs);
  }
}

function isComplete(entry: HistoryEntry): boolean {
  // Newer ComfyUI sets `completed: true`; older versions only set a status_str.
  // Treat either signal as the run-is-done barrier; the error branch is checked
  // by the caller before returning success.
  return entry.status?.completed === true
    || entry.status?.status_str === 'success'
    || entry.status?.status_str === 'error';
}

function summarizeMessages(messages: unknown[] | undefined): string {
  if (!Array.isArray(messages) || messages.length === 0) return '<no messages>';
  const out: string[] = [];
  for (const m of messages) {
    out.push(JSON.stringify(m).slice(0, 200));
    if (out.join(' | ').length > 800) break;
  }
  return out.join(' | ');
}

function extractAnalysisJson(
  entry: HistoryEntry,
  nodeId: string,
  promptId: string,
): string {
  const nodeOutput = entry.outputs?.[nodeId];
  if (!nodeOutput) {
    throw new Error(
      `Analyze node ${nodeId} produced no output for prompt ${promptId}. `
      + `Outputs present for nodes: ${Object.keys(entry.outputs ?? {}).join(',') || '<none>'}`,
    );
  }
  const analysisField = nodeOutput.analysis;
  if (!Array.isArray(analysisField) || analysisField.length === 0) {
    throw new Error(
      `Analyze output missing 'analysis' UI key for prompt ${promptId}. `
      + `Saw keys: ${Object.keys(nodeOutput).join(',') || '<none>'}. `
      + `Did nodes_analyze.py forget to wrap its return as { ui: { analysis: [json] }, result: (...) }?`,
    );
  }
  const raw = analysisField[0];
  if (typeof raw !== 'string') {
    throw new Error(`Analyze 'analysis' field is not a string (got ${typeof raw})`);
  }
  return raw;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
