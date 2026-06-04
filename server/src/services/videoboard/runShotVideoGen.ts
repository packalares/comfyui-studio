/**
 * Generate a video for a single videoboard shot via Studio's template engine.
 *
 * Mirrors `runShotImageGen` but targets LTX-2.3 FLF2V (or another FLF2V
 * template). The shot's still image is the first frame; the NEXT shot's
 * still image is the last frame. Duration in seconds comes straight from
 * the shot's `endMs - startMs`; we compute the LTX-required 4k+1 frame count
 * at the project's `videoFps` (default 25).
 *
 * Image plumbing: ComfyUI's LoadImage reads from /input/. Our shot images
 * live in /output/. Hard-link the source image into /input/ with a stable,
 * idempotent name (`vb_<projectId>_<idx>.png`) before submitting. Hard links
 * share the inode — free, no actual copy.
 *
 * Cancel-and-replace, isInflight, /api/queue?delete on cancel — same pattern
 * as runShotImageGen.
 */
import fs from 'fs';
import path from 'path';
import type { Shot, Project } from '../../contracts/videoboard.js';
import { logger } from '../../lib/logger.js';
import { collectNodeOutputFiles, type OutputFile } from '../../lib/mediaType.js';
import { paths } from '../../config/paths.js';
import { detectMediaType } from '../../lib/mediaType.js';
import { getHistoryForPrompt, deleteQueuedPrompts } from '../comfyui/api.js';
import { submitTemplate } from '../templates/submitTemplate.js';
import * as templates from '../templates/index.js';
import { resolveResolutionProxyIndices } from './resolveResolutionSlots.js';
import {
  trackComfyPrompt,
  getBridgeClientId,
  ComfyJobCancelledError,
  ComfyJobExecutionError,
} from './comfyJobBridge.js';

// ---------------------------------------------------------------------------
// Cancel-and-replace registry (per-shot, same shape as runShotImageGen)
// ---------------------------------------------------------------------------

interface InflightEntry {
  controller: AbortController;
  promptId: string | null;
}
const inflight = new Map<string, InflightEntry>();

function shotKey(projectId: string, idx: number): string {
  return `${projectId}:${idx}`;
}

export function isVideoInflight(projectId: string, idx: number): boolean {
  return inflight.has(shotKey(projectId, idx));
}

function cancelInflight(projectId: string, idx: number): void {
  const key = shotKey(projectId, idx);
  const prev = inflight.get(key);
  if (!prev) return;
  inflight.delete(key);
  try { prev.controller.abort(); } catch { /* re-abort on some Node versions */ }
  if (prev.promptId) {
    void deleteQueuedPrompts([prev.promptId]).catch(() => { /* best-effort */ });
  }
}

export function abortShotVideoGen(projectId: string, idx: number): boolean {
  const key = shotKey(projectId, idx);
  const e = inflight.get(key);
  if (!e) return false;
  inflight.delete(key);
  try { e.controller.abort(); } catch { /* see cancelInflight */ }
  if (e.promptId) void deleteQueuedPrompts([e.promptId]).catch(() => { });
  return true;
}

// ---------------------------------------------------------------------------
// Frame count math
// ---------------------------------------------------------------------------

/** LTX 2.3 requires output frame counts of the form `8k + 1` (temporal
 *  stride is 8, plus the +1 anchor frame). Anything else gets silently
 *  rounded DOWN by the model — so 125 frames at 25fps decodes to 121 frames
 *  (4.84s) instead of the intended 5s.
 *
 *  We round to the NEAREST valid 8k+1, biasing slightly UP (Math.ceil-ish)
 *  so a 5s shot lands at 129 frames (5.16s) instead of 121 (4.84s) — the
 *  user generally wants "at least the duration they asked for". Caller can
 *  bias differently by passing a slightly lower `durationSec`. */
export function ltxFrameCount(durationSec: number, fps: number): number {
  const raw = Math.max(0.2, durationSec) * fps;
  const k = Math.ceil((raw - 1) / 8);
  return Math.max(9, 8 * k + 1);
}

// ---------------------------------------------------------------------------
// Image staging
// ---------------------------------------------------------------------------

function parseViewUrl(url: string): { filename: string; subfolder: string; type: string } | null {
  const q = url.indexOf('?');
  if (q < 0) return null;
  const p = new URLSearchParams(url.slice(q + 1));
  const filename = p.get('filename');
  if (!filename) return null;
  return {
    filename,
    subfolder: p.get('subfolder') ?? '',
    type: p.get('type') ?? 'output',
  };
}

/** Stage a shot image into ComfyUI's /input/ tree so LoadImage can pick it
 *  up. Uses a deterministic name keyed by (projectId, role, shotIdx) so we
 *  overwrite rather than accumulate junk. Returns the input-relative
 *  filename to write to the LoadImage widget. */
function stageImageForInput(
  shotImageUrl: string,
  projectId: string,
  role: 'first' | 'last',
  shotIdx: number,
): string {
  const inputDir = paths.comfyInputDir;
  const outputDir = paths.comfyOutputDir;
  if (!inputDir || !outputDir) {
    throw new Error('ComfyUI input/output paths not configured (env.COMFYUI_PATH)');
  }
  const parsed = parseViewUrl(shotImageUrl);
  if (!parsed) throw new Error(`unparseable shot image_url: ${shotImageUrl}`);
  const sourceRoot = parsed.type === 'output' ? outputDir : inputDir;
  const sourceAbs = path.resolve(sourceRoot, parsed.subfolder, parsed.filename);
  if (!sourceAbs.startsWith(path.resolve(sourceRoot) + path.sep)) {
    throw new Error(`shot image path escapes source root: ${sourceAbs}`);
  }
  if (!fs.existsSync(sourceAbs)) {
    throw new Error(`shot image not on disk: ${sourceAbs}`);
  }
  const ext = path.extname(parsed.filename) || '.png';
  const stagedName = `vb_${projectId}_${role}_${shotIdx}${ext}`;
  const stagedAbs = path.resolve(inputDir, stagedName);
  if (!stagedAbs.startsWith(path.resolve(inputDir) + path.sep)) {
    throw new Error(`staged path escapes input root: ${stagedAbs}`);
  }
  // Overwrite any prior link/copy. Hard-link first (free on same fs); fall
  // back to copy if it fails (cross-fs, permissions).
  try { fs.unlinkSync(stagedAbs); } catch { /* missing is fine */ }
  try {
    fs.linkSync(sourceAbs, stagedAbs);
  } catch {
    fs.copyFileSync(sourceAbs, stagedAbs);
  }
  return stagedName;
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export interface RunShotVideoGenInput {
  project: Project;
  shot: Shot;
  /** The next shot in the storyboard, used for the last frame. Required for
   *  FLF2V. The route must reject for the final shot before calling here. */
  nextShot: Shot;
  /** Optional override; otherwise project.settings.videoTemplateName. */
  templateNameOverride?: string;
  /** Hard upper bound on a single run. Default 15 min (video gen is slow). */
  timeoutMs?: number;
}

export interface RunShotVideoGenResult {
  promptId: string;
  videoUrl: string;
  templateName: string;
  frames: number;
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_VIDEO_TEMPLATE = 'video_ltx2_3_flf2v';
const DEFAULT_VIDEO_FPS = 25;

export async function runShotVideoGen(
  input: RunShotVideoGenInput,
): Promise<RunShotVideoGenResult> {
  const { project, shot, nextShot } = input;
  const templateName =
    input.templateNameOverride
    || project.settings.videoTemplateName
    || DEFAULT_VIDEO_TEMPLATE;
  if (!templateName) {
    throw new Error('No video template configured');
  }
  if (!shot.imageUrl) {
    throw new Error(`Shot ${shot.idx} has no image to use as first frame`);
  }
  if (!nextShot.imageUrl) {
    throw new Error(`Next shot ${nextShot.idx} has no image to use as last frame`);
  }

  cancelInflight(project.id, shot.idx);
  const controller = new AbortController();
  const infEntry: InflightEntry = { controller, promptId: null };
  inflight.set(shotKey(project.id, shot.idx), infEntry);

  const promptText = (shot.videoPrompt && shot.videoPrompt.trim())
    || (shot.imagePrompt && shot.imagePrompt.trim())
    || shot.prompt
    || '';
  if (!promptText) {
    inflight.delete(shotKey(project.id, shot.idx));
    throw new Error(`Shot ${shot.idx} has no prompt text for video generation`);
  }

  // Stage first + last frames into /input/
  let firstFilename: string;
  let lastFilename: string;
  try {
    firstFilename = stageImageForInput(shot.imageUrl, project.id, 'first', shot.idx);
    lastFilename = stageImageForInput(nextShot.imageUrl, project.id, 'last', shot.idx);
  } catch (err) {
    inflight.delete(shotKey(project.id, shot.idx));
    throw new Error(`image staging failed: ${(err as Error).message}`);
  }

  // Frame count from duration.
  const fps = project.settings.videoFps ?? DEFAULT_VIDEO_FPS;
  const durationSec = (shot.endMs - shot.startMs) / 1000;
  const frames = ltxFrameCount(durationSec, fps);

  // Build advancedSettings: resolution via proxy (same as image gen) PLUS
  // frame count via raw-node override on the EmptyLTXVLatentVideo node.
  // The frame widget is named `length` and lives at the flattened compound
  // id `<wrapperInstanceId>:108` for the LTX-2.3 FLF2V template. Look it up
  // from the workflow at call time to stay robust against template edits.
  const workflow = templates.getUserWorkflowJson(templateName);
  if (!workflow) {
    inflight.delete(shotKey(project.id, shot.idx));
    throw new Error(`workflow file missing for template "${templateName}"`);
  }
  const advancedSettings: Record<string, { proxyIndex: number; value: unknown }> = {};

  // Resolution override (proxy slots).
  const { imageWidth, imageHeight } = project.settings;
  if (imageWidth && imageHeight) {
    const slots = resolveResolutionProxyIndices(workflow);
    if (slots) {
      advancedSettings.videoboard_width = { proxyIndex: slots.widthIdx, value: imageWidth };
      advancedSettings.videoboard_height = { proxyIndex: slots.heightIdx, value: imageHeight };
    }
  }

  // Frame count override (raw-node path).
  const latentNodeId = findLatentLengthNodeId(workflow);
  if (latentNodeId) {
    advancedSettings[`node:${latentNodeId}:length`] = { proxyIndex: -1, value: frames };
  } else {
    logger.warn?.(
      `[videoboard.shotVideo] template "${templateName}" has no EmptyLTXVLatentVideo node — frame override will not apply`,
    );
  }

  let promptId: string;
  try {
    const submitted = await submitTemplate({
      templateName,
      inputs: {
        prompt: promptText,
        image_0: firstFilename,
        image_1: lastFilename,
      },
      advancedSettings,
      provenance: { triggeredBy: 'ui' },
      clientId: getBridgeClientId(),
    });
    promptId = submitted.promptId;
    infEntry.promptId = promptId;
  } catch (err) {
    inflight.delete(shotKey(project.id, shot.idx));
    throw new Error(
      `submitTemplate("${templateName}") failed: ${(err as Error).message}`,
    );
  }
  logger.info?.(
    `[videoboard.shotVideo] submitted prompt ${promptId} for project=${project.id} shot=${shot.idx} frames=${frames} template=${templateName}`,
  );

  try {
    await trackComfyPrompt(promptId, {
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: controller.signal,
    });
  } catch (err) {
    inflight.delete(shotKey(project.id, shot.idx));
    if (err instanceof ComfyJobCancelledError || err instanceof ComfyJobExecutionError) {
      throw err;
    }
    throw new Error(`trackComfyPrompt(${promptId}) failed: ${(err as Error).message}`);
  }

  if (inflight.get(shotKey(project.id, shot.idx)) === infEntry) {
    inflight.delete(shotKey(project.id, shot.idx));
  }

  const entry = await fetchHistoryWithRetry(promptId);
  if (!entry) {
    throw new Error(
      `ComfyUI reported ${promptId} done but /history stayed null after retries`,
    );
  }
  const videoFile = pickFirstVideo(entry.outputs ?? {});
  if (!videoFile) {
    throw new Error(
      `prompt ${promptId} completed but produced no video output. Check template "${templateName}" — does it have a SaveVideo node?`,
    );
  }
  const videoUrl = buildViewUrl(videoFile);
  return { promptId, videoUrl, templateName, frames };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function fetchHistoryWithRetry(
  promptId: string,
  attempts = 6,
  initialDelayMs = 150,
): Promise<{ outputs?: Record<string, Record<string, unknown>>; status?: unknown } | null> {
  for (let i = 0; i < attempts; i++) {
    const entry = await getHistoryForPrompt(promptId);
    if (entry) return entry;
    if (i < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, initialDelayMs * (i + 1)));
    }
  }
  return null;
}

function pickFirstVideo(outputs: Record<string, Record<string, unknown>>): OutputFile | null {
  for (const nodeOutput of Object.values(outputs)) {
    const files = collectNodeOutputFiles(nodeOutput);
    for (const f of files) {
      if (detectMediaType(f.filename) === 'video') return f;
    }
  }
  return null;
}

function buildViewUrl(file: OutputFile): string {
  const params = new URLSearchParams({
    filename: file.filename,
    type: file.type ?? 'output',
  });
  if (file.subfolder) params.set('subfolder', file.subfolder);
  return `/api/view?${params.toString()}`;
}

/** Walk the workflow's subgraphs to find the EmptyLTXVLatentVideo node and
 *  return its FLATTENED compound id (e.g. `129:108`) so applyNodeOverrides
 *  can target it after `workflowToApiPrompt` runs. Returns null if not found. */
function findLatentLengthNodeId(workflow: Record<string, unknown>): string | null {
  // Top-level wrappers reference subgraph defs by their type uuid.
  const defs = ((workflow.definitions as Record<string, unknown> | undefined)?.subgraphs
    || []) as Array<Record<string, unknown>>;
  const topNodes = (workflow.nodes || []) as Array<Record<string, unknown>>;
  for (const wrapper of topNodes) {
    const wType = wrapper.type as string | undefined;
    if (!wType) continue;
    const def = defs.find(d => (d.id as string | undefined) === wType);
    if (!def) continue;
    const innerNodes = (def.nodes || []) as Array<Record<string, unknown>>;
    for (const n of innerNodes) {
      if (n.type === 'EmptyLTXVLatentVideo') {
        return `${wrapper.id}:${n.id}`;
      }
    }
  }
  // Top-level fallback (in case the template author lifted it out of subgraph).
  for (const n of topNodes) {
    if (n.type === 'EmptyLTXVLatentVideo') return String(n.id);
  }
  return null;
}
