/**
 * Generate an image for a single videoboard shot via Studio's template engine.
 *
 * Wires three already-built pieces — no new ComfyUI plumbing:
 *   1) `submitTemplate({ templateName, inputs: { prompt } })` (templates engine)
 *      → loads workflow JSON, builds API prompt, POSTs /api/prompt
 *   2) `trackComfyPrompt(promptId)` (comfyJobBridge)
 *      → WS-driven completion; rejects on cancel/error/interrupt
 *   3) `getHistoryForPrompt(promptId)` + `collectNodeOutputFiles` (comfyui lib)
 *      → extract first image, build /api/view URL, save onto the shot row
 *
 * Cancel-and-replace: each (projectId, idx) keeps one AbortController in a
 * module-level registry. Re-running for the same shot aborts the previous run
 * before submitting a new one — the bridge rejects the prior tracker with
 * ComfyJobCancelledError('caller'), the catch-clause flips the shot status,
 * and the new prompt is queued without waiting for the old GPU work to drain.
 */
import type { Shot, Project } from '../../contracts/videoboard.js';
import { logger } from '../../lib/logger.js';
import { collectNodeOutputFiles, type OutputFile } from '../../lib/mediaType.js';
import { getHistoryForPrompt } from '../comfyui/api.js';
import { submitTemplate } from '../templates/submitTemplate.js';
import * as templates from '../templates/index.js';
import { resolveResolutionProxyIndices } from './resolveResolutionSlots.js';
import {
  trackComfyPrompt,
  getBridgeClientId,
  ComfyJobCancelledError,
  ComfyJobExecutionError,
} from '../comfyui/jobBridge.js';

// ---------------------------------------------------------------------------
// Cancel-and-replace registry
// ---------------------------------------------------------------------------
//
// Each entry tracks the AbortController and the ComfyUI prompt_id we submitted
// (once known). On cancellation we ALSO call ComfyUI's /api/queue?delete to
// drop the prompt from the queue — otherwise ComfyUI happily finishes the
// dropped run and the image lands in /output/ as an orphan that nobody links
// back to a shot. The user-visible symptom was: Gallery full of recent images
// while shots stayed `pending`.

interface InflightEntry {
  controller: AbortController;
  promptId: string | null;
}
const inflight = new Map<string, InflightEntry>();

function shotKey(projectId: string, idx: number): string {
  return `${projectId}:${idx}`;
}

/** True iff there is an in-flight run for this shot right now. Callers that
 *  want at-most-one semantics (batch generate-all) should check this BEFORE
 *  calling runShotImageGen and skip the shot if it returns true. Per-shot
 *  manual Generate keeps the cancel-and-replace semantics — that path
 *  deliberately wants to redo a shot. */
export function isInflight(projectId: string, idx: number): boolean {
  return inflight.has(shotKey(projectId, idx));
}

function cancelInflight(projectId: string, idx: number): void {
  const key = shotKey(projectId, idx);
  const prev = inflight.get(key);
  if (!prev) return;
  inflight.delete(key);
  try { prev.controller.abort(); } catch { /* re-abort on some Node versions */ }
  // Best-effort: drop the prompt from ComfyUI's queue so it doesn't keep
  // rendering after we stopped listening. Fire-and-forget — we don't await,
  // and we swallow errors because there's nothing the caller can do.
  if (prev.promptId) {
    void deleteQueuedPrompt(prev.promptId);
  }
}

async function deleteQueuedPrompt(promptId: string): Promise<void> {
  try {
    const { deleteQueuedPrompts } = await import('../comfyui/api.js');
    await deleteQueuedPrompts([promptId]);
  } catch (err) {
    logger.warn?.(`[videoboard.shotImage] failed to delete queued prompt ${promptId}: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export interface RunShotImageGenInput {
  project: Project;
  shot: Shot;
  /** Optional per-call override (req.body.templateName from the route).
   *  Resolution order: opts.templateName → shot.imageTemplateName →
   *  project.settings.imageTemplateName. */
  templateNameOverride?: string;
  /** Hard upper bound on a single run. Default 10 min. */
  timeoutMs?: number;
}

export interface RunShotImageGenResult {
  promptId: string;
  imageUrl: string;
  templateName: string;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export async function runShotImageGen(
  input: RunShotImageGenInput,
): Promise<RunShotImageGenResult> {
  const { project, shot } = input;
  const templateName =
    input.templateNameOverride
    || shot.imageTemplateName
    || project.settings.imageTemplateName;
  if (!templateName) {
    throw new Error(
      'No image template configured (project.settings.imageTemplateName is empty and no override given).',
    );
  }

  // Cancel any previous run for THIS shot before kicking off a new one.
  // (Per-shot manual Generate Image deliberately wants this replace-semantics;
  // batch generate-all guards against double-submit with `isInflight()` so
  // it doesn't reach here with a still-active entry.)
  cancelInflight(project.id, shot.idx);
  const controller = new AbortController();
  const infEntry: InflightEntry = { controller, promptId: null };
  inflight.set(shotKey(project.id, shot.idx), infEntry);

  // Prefer the Director's image_prompt; fall back to the canonical `prompt`
  // for mock/legacy rows. Submit-side `submitTemplate` routes this through to
  // the template's prompt-role form field automatically (lines 164-166).
  const promptText = (shot.imagePrompt && shot.imagePrompt.trim())
    || shot.prompt
    || '';
  if (!promptText) {
    inflight.delete(shotKey(project.id, shot.idx));
    throw new Error(`Shot ${shot.idx} has no prompt text to generate from.`);
  }

  // Build advancedSettings for resolution override when the project has them set.
  let advancedSettings: Record<string, { proxyIndex: number; value: number }> | undefined;
  const { imageWidth, imageHeight } = project.settings;
  if (imageWidth && imageHeight) {
    const workflow = templates.getUserWorkflowJson(templateName);
    if (workflow) {
      const slots = resolveResolutionProxyIndices(workflow);
      if (slots) {
        advancedSettings = {
          videoboard_width: { proxyIndex: slots.widthIdx, value: imageWidth },
          videoboard_height: { proxyIndex: slots.heightIdx, value: imageHeight },
        };
      } else {
        console.warn(
          `[videoboard.shotImage] template "${templateName}" has no resolvable width/height proxy slots — skipping resolution override`,
        );
      }
    }
  }

  let promptId: string;
  try {
    const submitted = await submitTemplate({
      templateName,
      inputs: { prompt: promptText },
      advancedSettings,
      provenance: { triggeredBy: 'ui' },
      // Same clientId as the bridge's WS — required so ComfyUI routes
      // per-prompt events (executed / execution_success / execution_error)
      // back to the bridge instead of dropping them.
      clientId: getBridgeClientId(),
    });
    promptId = submitted.promptId;
    infEntry.promptId = promptId; // remember it so cancelInflight can drop it from ComfyUI's queue
  } catch (err) {
    inflight.delete(shotKey(project.id, shot.idx));
    throw new Error(
      `submitTemplate("${templateName}") failed: ${(err as Error).message}`,
    );
  }
  logger.info?.(
    `[videoboard.shotImage] submitted prompt ${promptId} for project=${project.id} shot=${shot.idx} template=${templateName}`,
  );

  try {
    await trackComfyPrompt(promptId, {
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: controller.signal,
    });
  } catch (err) {
    inflight.delete(shotKey(project.id, shot.idx));
    if (err instanceof ComfyJobCancelledError || err instanceof ComfyJobExecutionError) {
      throw err; // route maps these to job status + WS broadcast
    }
    throw new Error(
      `trackComfyPrompt(${promptId}) failed: ${(err as Error).message}`,
    );
  }

  // We won — clear the controller so subsequent cancels don't try to abort a
  // resolved run.
  if (inflight.get(shotKey(project.id, shot.idx)) === infEntry) {
    inflight.delete(shotKey(project.id, shot.idx));
  }

  // Fetch history. There's a small race between ComfyUI's execution_success
  // WS event (which our bridge resolved on) and the entry actually appearing
  // in /history. Retry a few times with short backoff — typically the entry
  // is there on the first or second attempt.
  const entry = await fetchHistoryWithRetry(promptId);
  if (!entry) {
    throw new Error(
      `ComfyUI reported ${promptId} done but /history stayed null after 6 retries. Did history get evicted?`,
    );
  }
  const imageFile = pickFirstImage(entry.outputs ?? {});
  if (!imageFile) {
    throw new Error(
      `prompt ${promptId} completed but produced no image-shaped output. Check template "${templateName}" — does it have a SaveImage node?`,
    );
  }
  const imageUrl = buildViewUrl(imageFile);
  return { promptId, imageUrl, templateName };
}

// ---------------------------------------------------------------------------
// Cancellation API (exposed so the routes layer can wire DELETE / replace).
// ---------------------------------------------------------------------------

/** Abort an in-flight shot image gen. Returns true if there was one to cancel. */
export function abortShotImageGen(projectId: string, idx: number): boolean {
  const key = shotKey(projectId, idx);
  const e = inflight.get(key);
  if (!e) return false;
  inflight.delete(key);
  try { e.controller.abort(); } catch { /* see cancelInflight */ }
  if (e.promptId) void deleteQueuedPrompt(e.promptId);
  return true;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * /history is populated by ComfyUI's executor a tick or two AFTER it emits
 * the `execution_success` WS event that resolved the bridge tracker.
 * Retry a handful of times with linear backoff before giving up so the
 * "bridge said done but history null" race doesn't poison every run.
 */
async function fetchHistoryWithRetry(
  promptId: string,
  attempts = 6,
  initialDelayMs = 150,
): Promise<{ outputs?: Record<string, Record<string, unknown>>; status?: unknown } | null> {
  for (let i = 0; i < attempts; i++) {
    const entry = await getHistoryForPrompt(promptId);
    if (entry) return entry;
    if (i < attempts - 1) {
      // linear backoff: 150, 300, 450, 600, 750 ms → ~2.25 s total max wait
      await new Promise((resolve) => setTimeout(resolve, initialDelayMs * (i + 1)));
    }
  }
  return null;
}

function pickFirstImage(outputs: Record<string, Record<string, unknown>>): OutputFile | null {
  // Walk every node's output bag, pick the first .png/.jpg/.webp file.
  // `collectNodeOutputFiles` returns mixed media (image/video/audio); we want
  // the first IMAGE specifically — Director shots are still frames.
  for (const nodeOutput of Object.values(outputs)) {
    const files = collectNodeOutputFiles(nodeOutput);
    for (const f of files) {
      if (isImageFile(f.filename)) return f;
    }
  }
  return null;
}

function isImageFile(filename: string): boolean {
  const ext = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
  return ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'webp' || ext === 'avif';
}

function buildViewUrl(file: OutputFile): string {
  const params = new URLSearchParams({
    filename: file.filename,
    type: file.type ?? 'output',
  });
  if (file.subfolder) params.set('subfolder', file.subfolder);
  return `/api/view?${params.toString()}`;
}
