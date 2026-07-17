/**
 * Generate one chain-mode i2v shot. Each shot is conditioned on the LAST
 * FRAME of the previous shot's video — extracted via ffmpeg after each run
 * and staged into ComfyUI's /input/ as a PNG. The model then runs a full
 * i2v from that frame.
 *
 * Why this shape (and not latent passthrough):
 * The earlier attempt at "latent memory" wired SaveLatent/LoadLatent through
 * a LatentSwitch. That setup silently dropped the freshly-sampled output and
 * re-decoded the previous shot's saved latent — i.e. every chain shot looked
 * like the previous one's video, decoded twice. The model never actually
 * generated continuation content.
 *
 * Last-frame extraction trades a tiny VAE re-encode hop per shot for actual
 * model-driven motion conditioned on the visible last frame. Spatial
 * continuity at the cut is guaranteed because the FIRST frame of shot N+1
 * literally IS the last frame of shot N.
 *
 * Pipeline per shot:
 *   1. Pick start frame:
 *      - shot 0 (or no prevVideoUrl): caller's `startingImageUrl`
 *      - shot N>0: ffmpeg-extracted last frame of previous shot's MP4
 *   2. Stage into /input/ as vbchain_<projectId>_<idx>.png
 *   3. submitTemplate(video_ltx2_3_i2v, inputs: { prompt, image_0 }, ...)
 *   4. trackComfyPrompt → /history → videoUrl
 *   5. Extract last frame of OUR mp4 → save as PNG in output, return its URL
 *
 * Cancel-and-replace + isInflight + /api/queue?delete on cancel — same shape
 * as runShotVideoGen / runShotImageGen.
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import type { Shot, Project } from '../../contracts/videoboard.js';
import { logger } from '../../lib/logger.js';
import { collectNodeOutputFiles, detectMediaType, type OutputFile } from '../../lib/mediaType.js';
import { paths } from '../../config/paths.js';
import { getHistoryForPrompt, deleteQueuedPrompts } from '../comfyui/api.js';
import { submitTemplate } from '../templates/submitTemplate.js';
import * as templates from '../templates/index.js';
import { resolveResolutionProxyIndices } from './resolveResolutionSlots.js';
import { ltxFrameCount } from './runShotVideoGen.js';
import {
  trackComfyPrompt,
  getBridgeClientId,
  ComfyJobCancelledError,
  ComfyJobExecutionError,
} from '../comfyui/jobBridge.js';

// ---------------------------------------------------------------------------
// Cancel-and-replace registry
// ---------------------------------------------------------------------------

interface InflightEntry {
  controller: AbortController;
  promptId: string | null;
}
const inflight = new Map<string, InflightEntry>();

function shotKey(projectId: string, idx: number): string {
  return `${projectId}:${idx}`;
}

export function isVideoChainInflight(projectId: string, idx: number): boolean {
  return inflight.has(shotKey(projectId, idx));
}

function cancelInflight(projectId: string, idx: number): void {
  const key = shotKey(projectId, idx);
  const prev = inflight.get(key);
  if (!prev) return;
  inflight.delete(key);
  try { prev.controller.abort(); } catch { /* re-abort tolerance */ }
  if (prev.promptId) {
    void deleteQueuedPrompts([prev.promptId]).catch(() => { /* best-effort */ });
  }
}

export function abortShotVideoChainGen(projectId: string, idx: number): boolean {
  const key = shotKey(projectId, idx);
  const e = inflight.get(key);
  if (!e) return false;
  inflight.delete(key);
  try { e.controller.abort(); } catch { /* see cancelInflight */ }
  if (e.promptId) void deleteQueuedPrompts([e.promptId]).catch(() => { });
  return true;
}

// ---------------------------------------------------------------------------
// View URL helpers (parse /api/view?... and resolve to disk paths)
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

function buildViewUrl(file: { filename: string; subfolder?: string; type?: string }): string {
  const params = new URLSearchParams({
    filename: file.filename,
    type: file.type ?? 'output',
  });
  if (file.subfolder) params.set('subfolder', file.subfolder);
  return `/api/view?${params.toString()}`;
}

function resolveViewToAbs(url: string): string | null {
  const parsed = parseViewUrl(url);
  if (!parsed) return null;
  const root = parsed.type === 'output' ? paths.comfyOutputDir : paths.comfyInputDir;
  if (!root) return null;
  const abs = path.resolve(root, parsed.subfolder, parsed.filename);
  if (!abs.startsWith(path.resolve(root) + path.sep)) return null;
  return abs;
}

// ---------------------------------------------------------------------------
// Image staging
// ---------------------------------------------------------------------------

/** Stage a PNG/JPG/etc image OR copy an arbitrary source file into ComfyUI's
 *  /input/ as `vbchain_<projectId>_<idx>.png`. Returns the input-relative
 *  filename for LoadImage. Hard-links when possible, falls back to copy. */
function stageImageForInput(
  sourceAbs: string,
  projectId: string,
  shotIdx: number,
): string {
  const inputDir = paths.comfyInputDir;
  if (!inputDir) throw new Error('ComfyUI input dir not configured');
  if (!fs.existsSync(sourceAbs)) {
    throw new Error(`source image missing on disk: ${sourceAbs}`);
  }
  const ext = path.extname(sourceAbs) || '.png';
  const stagedName = `vbchain_${projectId}_${shotIdx}${ext}`;
  const stagedAbs = path.resolve(inputDir, stagedName);
  if (!stagedAbs.startsWith(path.resolve(inputDir) + path.sep)) {
    throw new Error(`staged path escapes input root: ${stagedAbs}`);
  }
  try { fs.unlinkSync(stagedAbs); } catch { /* missing is fine */ }
  try {
    fs.linkSync(sourceAbs, stagedAbs);
  } catch {
    fs.copyFileSync(sourceAbs, stagedAbs);
  }
  return stagedName;
}

// ---------------------------------------------------------------------------
// ffmpeg: extract last frame of a video as PNG
// ---------------------------------------------------------------------------

/** Dump the FIRST frame of a video as PNG. Used as a fallback when a shot's
 *  recorded `imageUrl` no longer exists on disk (orphan cleanup left the row
 *  pointing at a missing file) but the shot still has a usable videoUrl. */
function extractFirstFrame(videoAbs: string, outPngAbs: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i', videoAbs,
      '-frames:v', '1',
      '-q:v', '1',
      outPngAbs,
    ];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr?.on('data', (c) => { stderr += c.toString().slice(0, 4000); });
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outPngAbs)) resolve();
      else reject(new Error(`ffmpeg first-frame exit ${code}: ${stderr.slice(-1000)}`));
    });
    proc.on('error', reject);
  });
}

/** Run `ffmpeg -sseof -2 -i <video> -update 1 -q:v 1 <outPng>` to dump the
 *  last second's final frame. Resolves on success, rejects on non-zero exit. */
function extractLastFrame(videoAbs: string, outPngAbs: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-sseof', '-2',
      '-i', videoAbs,
      '-update', '1',
      '-q:v', '1',
      outPngAbs,
    ];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr?.on('data', (chunk) => { stderr += chunk.toString().slice(0, 8000); });
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outPngAbs)) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(0, 500)}`));
    });
    proc.on('error', reject);
  });
}

/** Extract the LAST N frames of a video as a small MP4. LTXVAddGuide requires
 *  guide length to be 8*n + 1 frames, so callers should pass N = 17, 25, 33...
 *  At 25 fps, 17 frames = 0.68 sec — enough motion context without bulking
 *  the conditioning. We seek (N/fps + 0.1) sec before EOF then take N frames.
 *  The extra 0.1s lead-in protects against seek imprecision around keyframes. */
function extractLastNFramesAsClip(
  videoAbs: string,
  outMp4Abs: string,
  frameCount: number,
  fps: number,
): Promise<void> {
  const seekSec = (frameCount / Math.max(1, fps)) + 0.1;
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-sseof', `-${seekSec.toFixed(3)}`,
      '-i', videoAbs,
      '-frames:v', String(frameCount),
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-an',
      outMp4Abs,
    ];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr?.on('data', (c) => { stderr += c.toString().slice(0, 8000); });
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outMp4Abs)) resolve();
      else reject(new Error(`ffmpeg tail-clip exit ${code}: ${stderr.slice(-2500)}`));
    });
    proc.on('error', reject);
  });
}

/** Make a still-frame "freeze" MP4 of N frames from a single image. Used for
 *  shot 0 in chain mode: the starter image becomes the FIRST frame anchor;
 *  the freeze video lets the same template path consume it (no special-case
 *  branch needed). */
function makeFreezeClipFromImage(
  imageAbs: string,
  outMp4Abs: string,
  frameCount: number,
  fps: number,
): Promise<void> {
  const duration = frameCount / Math.max(1, fps);
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-loop', '1',
      '-i', imageAbs,
      '-t', duration.toFixed(3),
      '-r', String(fps),
      '-frames:v', String(frameCount),
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      outMp4Abs,
    ];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr?.on('data', (c) => { stderr += c.toString().slice(0, 8000); });
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outMp4Abs)) resolve();
      else reject(new Error(`ffmpeg freeze-clip exit ${code}: src=${imageAbs} dst=${outMp4Abs} stderr=${stderr.slice(-2500)}`));
    });
    proc.on('error', reject);
  });
}

/** Stage an arbitrary file from anywhere on disk into ComfyUI's /input/ tree.
 *  Hard-links when same-fs; falls back to copy. Returns the staged filename. */
function stageFileForInput(sourceAbs: string, stagedName: string): string {
  const inputDir = paths.comfyInputDir;
  if (!inputDir) throw new Error('ComfyUI input dir not configured');
  if (!fs.existsSync(sourceAbs)) {
    throw new Error(`source missing on disk: ${sourceAbs}`);
  }
  const stagedAbs = path.resolve(inputDir, stagedName);
  if (!stagedAbs.startsWith(path.resolve(inputDir) + path.sep)) {
    throw new Error(`staged path escapes input root: ${stagedAbs}`);
  }
  try { fs.unlinkSync(stagedAbs); } catch { /* fine */ }
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

export interface RunShotVideoChainGenInput {
  project: Project;
  shot: Shot;
  /** For shot 0 (or any reseed): a view URL of the image to use as the
   *  starting frame. The shot generator turns it into a 17-frame freeze MP4
   *  so the same template path handles both shot 0 and chained shots. */
  startingImageUrl?: string;
  /** For shot N>0: the previous shot's video URL. We extract its last 17
   *  frames as a motion-context clip and feed THAT to LTXVAddGuide. */
  prevVideoUrl?: string;
  /** Optional: the previous shot's `keyVisual` (1-line composition tag). When
   *  set, we prefix the new shot's prompt with "Continuing from: <prev>." so
   *  the text encoder has narrative bridge context. */
  prevKeyVisual?: string;
  templateNameOverride?: string;
  timeoutMs?: number;
}

export interface RunShotVideoChainGenResult {
  promptId: string;
  videoUrl: string;
  /** URL of the PNG we extracted from the END of this shot's video. The
   *  orchestrator carries this forward as the NEXT shot's start frame and
   *  also persists it on the shot row so resume works after a process
   *  restart. */
  lastFrameUrl: string;
  templateName: string;
  frames: number;
}

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000; // 20 min — chained i2v is slow
const DEFAULT_VIDEO_TEMPLATE = 'video_ltx2_3_i2v';
const DEFAULT_VIDEO_FPS = 25;

export async function runShotVideoChainGen(
  input: RunShotVideoChainGenInput,
): Promise<RunShotVideoChainGenResult> {
  const { project, shot, prevVideoUrl, startingImageUrl } = input;
  const templateName =
    input.templateNameOverride
    || project.settings.videoTemplateName
    || DEFAULT_VIDEO_TEMPLATE;

  cancelInflight(project.id, shot.idx);
  const controller = new AbortController();
  const infEntry: InflightEntry = { controller, promptId: null };
  inflight.set(shotKey(project.id, shot.idx), infEntry);

  const rawPrompt = (shot.videoPrompt && shot.videoPrompt.trim())
    || (shot.imagePrompt && shot.imagePrompt.trim())
    || shot.prompt
    || '';
  if (!rawPrompt) {
    inflight.delete(shotKey(project.id, shot.idx));
    throw new Error(`Shot ${shot.idx} has no prompt text for chain video generation`);
  }
  // Strategy B from the design: prefix the new shot's prompt with the
  // previous shot's keyVisual as a 1-line "continuing from" bridge. Compact,
  // focused, keeps the prompt within LTX's text encoder context budget.
  const promptText = input.prevKeyVisual && input.prevKeyVisual.trim()
    ? `Continuing from: ${input.prevKeyVisual.trim()}. ${rawPrompt}`
    : rawPrompt;

  const fps = project.settings.videoFps ?? DEFAULT_VIDEO_FPS;

  // ---- 1. Resolve start frame as a SINGLE PNG ---------------------------
  // For shot 0: use shot.imageUrl (with fallback to videoUrl's first frame).
  // For shot N>0: extract last frame of prev shot's mp4 as PNG.
  const outputDir = paths.comfyOutputDir;
  if (!outputDir) {
    inflight.delete(shotKey(project.id, shot.idx));
    throw new Error('ComfyUI output dir not configured');
  }
  const stagingDir = path.resolve(outputDir, 'vbchain_frames');
  fs.mkdirSync(stagingDir, { recursive: true });
  let startFrameAbs: string;
  try {
    if (prevVideoUrl) {
      const prevVideoAbs = resolveViewToAbs(prevVideoUrl);
      if (!prevVideoAbs) throw new Error(`could not resolve prev video URL: ${prevVideoUrl}`);
      const lastFrameAbs = path.resolve(stagingDir, `prev_for_${project.id}_${shot.idx}.png`);
      await extractLastFrame(prevVideoAbs, lastFrameAbs);
      startFrameAbs = lastFrameAbs;
    } else {
      const seedUrl = startingImageUrl ?? shot.imageUrl;
      if (!seedUrl) throw new Error('chain shot needs prevVideoUrl, startingImageUrl, or shot.imageUrl');
      let seedAbs = resolveViewToAbs(seedUrl);
      if (!seedAbs) throw new Error(`could not resolve seed image URL: ${seedUrl}`);
      // Fallback: if file is gone but shot has a usable videoUrl, recover via first frame.
      if (!fs.existsSync(seedAbs) && shot.videoUrl) {
        const fallbackVideoAbs = resolveViewToAbs(shot.videoUrl);
        if (fallbackVideoAbs && fs.existsSync(fallbackVideoAbs)) {
          const rescued = path.resolve(stagingDir, `seed_rescue_${project.id}_${shot.idx}.png`);
          await extractFirstFrame(fallbackVideoAbs, rescued);
          seedAbs = rescued;
          logger.info?.(
            `[videoboard.shotVideoChain] shot=${shot.idx} seed image missing; recovered from existing videoUrl`,
          );
        }
      }
      if (!fs.existsSync(seedAbs)) {
        throw new Error(`seed image not on disk: ${seedAbs}`);
      }
      startFrameAbs = seedAbs;
    }
  } catch (err) {
    inflight.delete(shotKey(project.id, shot.idx));
    throw new Error(`start-frame resolution failed: ${(err as Error).message}`);
  }

  // ---- 2. Stage the PNG into ComfyUI's /input/ for LoadImage ------------
  let imageFilename: string;
  try {
    const ext = path.extname(startFrameAbs) || '.png';
    imageFilename = stageFileForInput(startFrameAbs, `vbchain_${project.id}_${shot.idx}${ext}`);
  } catch (err) {
    inflight.delete(shotKey(project.id, shot.idx));
    throw new Error(`start-frame staging failed: ${(err as Error).message}`);
  }

  // ---- 3. Build advanced settings: resolution + frame count -------------
  // (fps already declared above for the motion-clip ffmpeg call)
  const durationSec = (shot.endMs - shot.startMs) / 1000;
  const frames = ltxFrameCount(durationSec, fps);
  const workflow = templates.getUserWorkflowJson(templateName);
  if (!workflow) {
    inflight.delete(shotKey(project.id, shot.idx));
    throw new Error(`workflow file missing for template "${templateName}"`);
  }
  const advancedSettings: Record<string, { proxyIndex: number; value: unknown }> = {};
  const { imageWidth, imageHeight } = project.settings;
  if (imageWidth && imageHeight) {
    const slots = resolveResolutionProxyIndices(workflow);
    if (slots) {
      advancedSettings.videoboard_width = { proxyIndex: slots.widthIdx, value: imageWidth };
      advancedSettings.videoboard_height = { proxyIndex: slots.heightIdx, value: imageHeight };
    }
  }
  const latentNodeId = findLatentLengthNodeId(workflow);
  if (latentNodeId) {
    advancedSettings[`node:${latentNodeId}:length`] = { proxyIndex: -1, value: frames };
  } else {
    logger.warn?.(
      `[videoboard.shotVideoChain] template "${templateName}" has no EmptyLTXVLatentVideo node — frame override will not apply`,
    );
  }

  // ---- 4. Submit + track ------------------------------------------------
  let promptId: string;
  try {
    const submitted = await submitTemplate({
      templateName,
      inputs: {
        prompt: promptText,
        image_0: imageFilename,
      },
      advancedSettings,
      provenance: { triggeredBy: 'ui' },
      clientId: getBridgeClientId(),
    });
    promptId = submitted.promptId;
    infEntry.promptId = promptId;
  } catch (err) {
    inflight.delete(shotKey(project.id, shot.idx));
    throw new Error(`submitTemplate("${templateName}") failed: ${(err as Error).message}`);
  }
  logger.info?.(
    `[videoboard.shotVideoChain] submitted prompt ${promptId} for project=${project.id} shot=${shot.idx} frames=${frames} template=${templateName} starting from ${prevVideoUrl ? 'prev last frame' : 'seed image'}`,
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

  // ---- 5. Fetch /history, find the video file --------------------------
  const entry = await fetchHistoryWithRetry(promptId);
  if (!entry) {
    throw new Error(`ComfyUI reported ${promptId} done but /history stayed null after retries`);
  }
  const videoFile = pickFirstVideo(entry.outputs ?? {});
  if (!videoFile) {
    throw new Error(
      `prompt ${promptId} completed but produced no video output. Check template "${templateName}"`,
    );
  }
  const videoUrl = buildViewUrl(videoFile);

  // ---- 6. Extract THIS shot's last frame for the next iteration ---------
  const videoAbs = resolveViewToAbs(videoUrl);
  if (!videoAbs) {
    throw new Error(`could not resolve generated video URL to disk: ${videoUrl}`);
  }
  // outputDir was already resolved earlier; reuse the same constant.
  const lastFrameDir = path.resolve(outputDir, 'vbchain_frames');
  fs.mkdirSync(lastFrameDir, { recursive: true });
  const lastFrameName = `last_${project.id}_${shot.idx}.png`;
  const lastFrameAbs = path.resolve(lastFrameDir, lastFrameName);
  try {
    await extractLastFrame(videoAbs, lastFrameAbs);
  } catch (err) {
    // Soft-fail: shot succeeded, but downstream chain shots will fall back
    // to whatever start frame they had. Log + carry on.
    logger.warn?.(
      `[videoboard.shotVideoChain] last-frame extract failed for shot=${shot.idx}: ${(err as Error).message}`,
    );
  }
  const lastFrameUrl = fs.existsSync(lastFrameAbs)
    ? buildViewUrl({ filename: lastFrameName, subfolder: 'vbchain_frames', type: 'output' })
    : videoUrl; // fallback: signal something so the route persists SOMETHING

  return { promptId, videoUrl, lastFrameUrl, templateName, frames };
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
      await new Promise((r) => setTimeout(r, initialDelayMs * (i + 1)));
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

function findLatentLengthNodeId(workflow: Record<string, unknown>): string | null {
  const defs = ((workflow.definitions as Record<string, unknown> | undefined)?.subgraphs
    || []) as Array<Record<string, unknown>>;
  const topNodes = (workflow.nodes || []) as Array<Record<string, unknown>>;
  for (const wrapper of topNodes) {
    const wType = wrapper.type as string | undefined;
    if (!wType) continue;
    const def = defs.find((d) => (d.id as string | undefined) === wType);
    if (!def) continue;
    const innerNodes = (def.nodes || []) as Array<Record<string, unknown>>;
    for (const n of innerNodes) {
      if (n.type === 'EmptyLTXVLatentVideo') {
        return `${wrapper.id}:${n.id}`;
      }
    }
  }
  for (const n of topNodes) {
    if (n.type === 'EmptyLTXVLatentVideo') return String(n.id);
  }
  return null;
}
