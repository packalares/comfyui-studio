// Videoboard routes — projects, audio, shots, storyboard, render.
// All job-producing endpoints are stubs: they schedule a fake async job via
// setTimeout, write the resulting rows to SQLite, and broadcast WS events.
// Real ML wiring (ComfyUI image/video gen, ffmpeg render) is added later.

import fs from 'fs';
import path from 'path';
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { sendError } from '../middleware/errors.js';
import * as repo from '../lib/db/videoboard.repo.js';
import * as jobTracker from '../services/videoboard/jobTracker.js';
import * as storage from '../services/videoboard/storage.js';
import { paths } from '../config/paths.js';
import type { Shot } from '../contracts/videoboard.js';
import { analyzeViaComfyUI } from '../services/videoboard/comfyAnalyze.js';
import { scenesViaComfyUI, type DirectorShot } from '../services/videoboard/comfyScenes.js';
import { runShotImageGen, isInflight } from '../services/videoboard/runShotImageGen.js';
import { runShotVideoGen, isVideoInflight } from '../services/videoboard/runShotVideoGen.js';
import {
  runShotVideoChainGen,
  isVideoChainInflight,
} from '../services/videoboard/runShotVideoChainGen.js';
import {
  ComfyJobCancelledError,
  ComfyJobExecutionError,
} from '../services/videoboard/comfyJobBridge.js';

// ---- Orphan file cleanup ----------------------------------------------------
// When a storyboard regeneration replaces existing shots, the old shot rows
// are atomically swapped via repo.replaceShots, but the on-disk image/video
// files (in ComfyUI's output tree) become orphans. Walk the URL list and
// best-effort unlink each backing file. Errors are swallowed — file might
// have already been deleted, never existed (placeholder), or live outside
// our output tree (don't traverse out).

/** True if a /api/view?... URL resolves to a real file on disk. Used by
 *  the chain route to detect the "DB references a deleted file" case so we
 *  can auto-regenerate instead of erroring deep inside ffmpeg. */
function viewUrlPointsToExistingFile(url: string | undefined | null): boolean {
  if (!url) return false;
  const q = url.indexOf('?');
  if (q < 0) return false;
  const p = new URLSearchParams(url.slice(q + 1));
  const filename = p.get('filename');
  if (!filename) return false;
  const type = p.get('type') ?? 'output';
  const subfolder = p.get('subfolder') ?? '';
  const root = type === 'output' ? paths.comfyOutputDir : paths.comfyInputDir;
  if (!root) return false;
  const abs = path.resolve(root, subfolder, filename);
  if (!abs.startsWith(path.resolve(root) + path.sep)) return false;
  return fs.existsSync(abs);
}

function deleteOrphanedFiles(urls: string[]): void {
  const outputDir = paths.comfyOutputDir;
  if (!outputDir || urls.length === 0) return;
  for (const url of urls) {
    try {
      // Studio's view URLs are `/api/view?filename=...&subfolder=...&type=output`
      const q = url.indexOf('?');
      if (q < 0) continue;
      const params = new URLSearchParams(url.slice(q + 1));
      const filename = params.get('filename');
      if (!filename) continue;
      // Only delete from the output tree, never input/temp.
      if ((params.get('type') ?? 'output') !== 'output') continue;
      const subfolder = params.get('subfolder') ?? '';
      // path.resolve + startsWith guard prevents traversal via crafted
      // subfolder/filename values like '../../etc/passwd'.
      const abs = path.resolve(outputDir, subfolder, filename);
      if (!abs.startsWith(path.resolve(outputDir) + path.sep)) continue;
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    } catch { /* best-effort; never fail the route on cleanup */ }
  }
}

// ---- Multer setup -----------------------------------------------------------

const audioUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, paths.uploadsTmpDir),
    filename: (_req, _file, cb) =>
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
  }),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB
});

// ---- WS broadcaster re-export (set by index.ts) ----------------------------
// jobTracker holds the broadcaster; route stubs emit project/shot/analysis
// events directly here using this helper.
let _broadcast: ((payload: object) => void) | null = null;
export function setVideoboardRouteBroadcaster(fn: ((payload: object) => void) | null): void {
  _broadcast = fn;
}
function emit(payload: object): void {
  if (_broadcast) _broadcast(payload);
}

const router = Router();

// ============================================================================
// PROJECTS
// ============================================================================

// GET /api/videoboard/projects
router.get('/videoboard/projects', (_req: Request, res: Response): void => {
  try {
    res.json(repo.listProjects());
  } catch (err) { sendError(res, err, 500, 'Failed to list projects'); }
});

// POST /api/videoboard/projects
router.post('/videoboard/projects', (req: Request, res: Response): void => {
  try {
    const name = String((req.body as Record<string, unknown>)?.name ?? 'Untitled');
    const project = repo.createProject(randomUUID(), name);
    res.status(201).json(project);
  } catch (err) { sendError(res, err, 500, 'Failed to create project'); }
});

// GET /api/videoboard/projects/:id
router.get('/videoboard/projects/:id', (req: Request, res: Response): void => {
  try {
    const project = repo.getProject(req.params.id as string);
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    res.json(project);
  } catch (err) { sendError(res, err, 500, 'Failed to get project'); }
});

// PUT /api/videoboard/projects/:id
router.put('/videoboard/projects/:id', (req: Request, res: Response): void => {
  try {
    const id = req.params.id as string;
    const updated = repo.updateProject(id, req.body as Parameters<typeof repo.updateProject>[1]);
    if (!updated) { res.status(404).json({ error: 'Project not found' }); return; }
    res.json(updated);
  } catch (err) { sendError(res, err, 500, 'Failed to update project'); }
});

// DELETE /api/videoboard/projects/:id
router.delete('/videoboard/projects/:id', (req: Request, res: Response): void => {
  try {
    const deleted = repo.deleteProject(req.params.id as string);
    if (!deleted) { res.status(404).json({ error: 'Project not found' }); return; }
    res.json({ ok: true });
  } catch (err) { sendError(res, err, 500, 'Failed to delete project'); }
});

// ============================================================================
// AUDIO
// ============================================================================

// POST /api/videoboard/projects/:id/audio
router.post(
  '/videoboard/projects/:id/audio',
  audioUpload.single('audio'),
  (req: Request, res: Response): void => {
    try {
      const id = req.params.id as string;
      const project = repo.getProject(id);
      if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
      if (!req.file) { res.status(400).json({ error: 'No audio file provided' }); return; }
      const ext = path.extname(req.file.originalname).replace('.', '') || 'mp3';
      storage.ensureProjectDir(id);
      const dest = storage.audioPath(id, ext);
      fs.renameSync(req.file.path, dest);
      // Audio replaced — wipe the old analysis AND old storyboard shots
      // (both were derived from the previous song and are now stale).
      repo.deleteAnalysis(id);
      repo.deleteShots(id);
      const replaced = repo.updateProject(id, {
        audioPath: dest,
        audioDurationMs: undefined,
        analysisStatus: 'none',
      });
      if (replaced) emit({ type: 'videoboard:project:updated', project: replaced });
      res.json({ audioPath: dest });
    } catch (err) { sendError(res, err, 500, 'Audio upload failed'); }
  },
);

// GET /api/videoboard/projects/:id/audio — stream the uploaded audio
// (sendFile handles Range automatically so <audio> seeking works)
router.get('/videoboard/projects/:id/audio', (req: Request, res: Response): void => {
  try {
    const project = repo.getProject(req.params.id as string);
    if (!project?.audioPath) { res.status(404).json({ error: 'No audio uploaded' }); return; }
    if (!fs.existsSync(project.audioPath)) { res.status(404).json({ error: 'Audio file missing' }); return; }
    res.sendFile(project.audioPath);
  } catch (err) { sendError(res, err, 500, 'Failed to stream audio'); }
});

// DELETE /api/videoboard/projects/:id/audio
// Removes the audio file from disk, clears the analysis row, and resets
// project state. Returns the updated project.
router.delete('/videoboard/projects/:id/audio', (req: Request, res: Response): void => {
  try {
    const id = req.params.id as string;
    const project = repo.getProject(id);
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    // Best-effort: delete the file if it exists. Don't fail the request if the
    // file was already missing — the DB is the source of truth.
    if (project.audioPath) {
      try { fs.unlinkSync(project.audioPath); } catch { /* may already be gone */ }
    }
    // Cascade: analysis + storyboard shots were derived from this audio,
    // so they're meaningless once the audio is gone. Wipe both.
    repo.deleteAnalysis(id);
    repo.deleteShots(id);
    const updated = repo.updateProject(id, {
      audioPath: undefined,
      audioDurationMs: undefined,
      analysisStatus: 'none',
    });
    if (updated) emit({ type: 'videoboard:project:updated', project: updated });
    res.json(updated);
  } catch (err) { sendError(res, err, 500, 'Failed to remove audio'); }
});

// POST /api/videoboard/projects/:id/analyze
router.post('/videoboard/projects/:id/analyze', (req: Request, res: Response): void => {
  try {
    const id = req.params.id as string;
    const project = repo.getProject(id);
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    if (!project.audioPath) { res.status(400).json({ error: 'Project has no audio uploaded' }); return; }
    if (!fs.existsSync(project.audioPath)) { res.status(400).json({ error: 'Audio file missing on disk' }); return; }

    repo.updateProject(id, { analysisStatus: 'pending' });
    const job = jobTracker.createJob(id, 'analyze');
    res.json({ jobId: job.id });

    // Fire-and-forget background analyze. The audio file or even the whole
    // project may be deleted while we're mid-flight — we re-fetch the
    // project at the persist point and abort the write if the audio is gone
    // or the project itself has been removed. The ComfyUI run keeps going on
    // the GPU (we don't propagate cancel down to it yet — cheaper to discard
    // the result than to wire abort plumbing into a polling loop).
    const expectedAudioPath = project.audioPath;
    (async () => {
      function audioStillThere(): boolean {
        const p = repo.getProject(id);
        return !!p && p.audioPath === expectedAudioPath;
      }

      try {
        jobTracker.updateJob(job.id, { status: 'running', progress: 0.1 });
        const { analysis, promptId } = await analyzeViaComfyUI({
          audioPath: expectedAudioPath,
          identifier: id,
        });

        if (!audioStillThere()) {
          jobTracker.updateJob(job.id, {
            status: 'error',
            message: 'cancelled: audio was removed mid-analyze',
          });
          return;
        }

        repo.upsertAnalysis(id, analysis);
        repo.updateProject(id, {
          analysisStatus: 'ready',
          audioDurationMs: analysis.duration_ms,
        });
        jobTracker.updateJob(job.id, {
          status: 'done',
          progress: 1,
          message: `prompt=${promptId}`,
        });
        const updated = repo.getProject(id);
        if (updated) emit({ type: 'videoboard:project:updated', project: updated });
        emit({ type: 'videoboard:analysis:updated', projectId: id, analysis });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (audioStillThere()) {
          repo.updateProject(id, { analysisStatus: 'error' });
          const updated = repo.getProject(id);
          if (updated) emit({ type: 'videoboard:project:updated', project: updated });
        }
        jobTracker.updateJob(job.id, { status: 'error', message: msg });
      }
    })();
  } catch (err) { sendError(res, err, 500, 'Analyze failed'); }
});

// GET /api/videoboard/projects/:id/analysis
router.get('/videoboard/projects/:id/analysis', (req: Request, res: Response): void => {
  try {
    const analysis = repo.getAnalysis(req.params.id as string);
    res.json(analysis);
  } catch (err) { sendError(res, err, 500, 'Failed to get analysis'); }
});

// ============================================================================
// STORYBOARD / SHOTS
// ============================================================================

// POST /api/videoboard/projects/:id/storyboard/generate
// Runs the OMNI_AUDIO_VideoScenes (Director) node on the project's audio +
// analysis. Returns immediately with a jobId; the actual GGUF run is
// fire-and-forget on the background pool and takes minutes. WS events keep
// the UI in sync.
//
// Preconditions enforced:
//   - project exists
//   - project has audio on disk
//   - analysis is 'ready' (no analysis → no analysis_json → Director can't run)
router.post('/videoboard/projects/:id/storyboard/generate', (req: Request, res: Response): void => {
  try {
    const id = req.params.id as string;
    const project = repo.getProject(id);
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    if (!project.audioPath) { res.status(400).json({ error: 'Project has no audio uploaded' }); return; }
    if (!fs.existsSync(project.audioPath)) { res.status(400).json({ error: 'Audio file missing on disk' }); return; }
    if (project.analysisStatus !== 'ready') {
      res.status(400).json({
        error: 'Analyze the audio before generating the storyboard',
        analysisStatus: project.analysisStatus,
      });
      return;
    }
    const analysis = repo.getAnalysis(id);
    if (!analysis) {
      res.status(400).json({ error: 'Analysis row is missing — re-run Analyze' });
      return;
    }

    // Delete-on-click semantics (Option B): wipe existing shots + their on-disk
    // files BEFORE submitting the Director run. The UI gets immediate feedback
    // (storyboard cleared) and the next Director run starts from a clean
    // slate. Trade-off vs the atomic-on-success approach: if the Director run
    // errors out, the user's previous shots are gone — the confirm dialog
    // in the UI is the explicit acknowledgement of that risk.
    const orphanedUrls: string[] = [];
    for (const s of project.shots ?? []) {
      if (s.imageUrl) orphanedUrls.push(s.imageUrl);
      if (s.videoUrl) orphanedUrls.push(s.videoUrl);
    }
    if (project.shots && project.shots.length > 0) {
      repo.deleteShots(id);
      deleteOrphanedFiles(orphanedUrls);
    }

    const job = jobTracker.createJob(id, 'storyboard');
    repo.updateProject(id, { status: 'generating' });
    res.json({ jobId: job.id });

    // Tell the UI immediately so the empty-state shows while the Director runs.
    const projectAfterDelete = repo.getProject(id);
    if (projectAfterDelete) {
      emit({ type: 'videoboard:project:updated', project: projectAfterDelete });
    }

    const expectedAudioPath = project.audioPath;
    (async () => {
      function audioStillThere(): boolean {
        const p = repo.getProject(id);
        return !!p && p.audioPath === expectedAudioPath;
      }

      try {
        jobTracker.updateJob(job.id, { status: 'running', progress: 0.1 });

        const { shots: directorShots, promptId, treatment } = await scenesViaComfyUI({
          audioPath: expectedAudioPath,
          analysisJson: JSON.stringify(analysis),
          identifier: id,                          // project id — surfaces in ComfyUI canvas + /history
          shotSeconds: project.settings.fixedShotSeconds,
          styleHint: project.settings.styleHint,
        });

        if (!audioStillThere()) {
          jobTracker.updateJob(job.id, {
            status: 'error',
            message: 'cancelled: audio was removed mid-generate',
          });
          return;
        }

        const shots: Shot[] = directorShots.map((s: DirectorShot, i: number) => ({
          idx: i,
          startMs: Math.round(s.start * 1000),
          endMs: Math.round(s.end * 1000),
          lyrics: '',                              // not provided by Director (TODO: lift sung-words later)
          prompt: s.image_prompt || s.description, // canonical "prompt" = the still-image one
          seed: Math.floor(Math.random() * 2 ** 31),
          status: 'pending' as const,
          imagePrompt: s.image_prompt,
          videoPrompt: s.video_prompt,
          keyVisual: s.key_visual,
          treatmentSnapshot: s.treatment_snapshot,
          chunkIdx: s.chunk_idx,
        }));

        // Shots and their disk files were already wiped above before the
        // Director run started, so no orphan cleanup is needed here. Just
        // write the new shots.
        repo.replaceShots(id, shots);
        repo.updateProject(id, { status: 'draft' });
        jobTracker.updateJob(job.id, {
          status: 'done',
          progress: 1.0,
          message: `prompt=${promptId}; ${shots.length} shots; treatment ${treatment.length}ch`,
        });
        const updated = repo.getProject(id);
        if (updated) emit({ type: 'videoboard:project:updated', project: updated });
        for (const s of shots) emit({ type: 'videoboard:shot:updated', projectId: id, shot: s });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (audioStillThere()) {
          repo.updateProject(id, { status: 'draft' });
          const updated = repo.getProject(id);
          if (updated) emit({ type: 'videoboard:project:updated', project: updated });
        }
        jobTracker.updateJob(job.id, { status: 'error', message: msg });
      }
    })();
  } catch (err) { sendError(res, err, 500, 'Storyboard generate failed'); }
});

// PUT /api/videoboard/projects/:id/shots/:idx
router.put('/videoboard/projects/:id/shots/:idx', (req: Request, res: Response): void => {
  try {
    const id = req.params.id as string;
    const idx = Number(req.params.idx);
    const updated = repo.updateShot(id, idx, req.body as Partial<Shot>);
    if (!updated) { res.status(404).json({ error: 'Shot not found' }); return; }
    emit({ type: 'videoboard:shot:updated', projectId: id, shot: updated });
    res.json(updated);
  } catch (err) { sendError(res, err, 500, 'Failed to update shot'); }
});

// POST /api/videoboard/projects/:id/shots/:idx/image
// Generates a still image for a single shot via Studio's template engine.
//   body: { templateName? }   ← per-shot override; falls back to shot.imageTemplateName
//                               then project.settings.imageTemplateName.
//
// Returns immediately with a jobId. The actual ComfyUI run is fire-and-forget
// on the background pool; comfyJobBridge.trackComfyPrompt resolves on
// execution_success / cancelled / error. WS events keep the UI live.
//
// Re-pressing Generate Images for the same shot mid-run cancels the previous
// run via runShotImageGen's per-shot AbortController (cancel-and-replace).
router.post('/videoboard/projects/:id/shots/:idx/image', (req: Request, res: Response): void => {
  try {
    const id = req.params.id as string;
    const idx = Number(req.params.idx);
    const project = repo.getProject(id);
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    const shot = repo.getShot(id, idx);
    if (!shot) { res.status(404).json({ error: 'Shot not found' }); return; }

    const body = (req.body ?? {}) as { templateName?: unknown };
    const templateNameOverride = typeof body.templateName === 'string' && body.templateName.length > 0
      ? body.templateName
      : undefined;

    repo.updateShot(id, idx, { status: 'queued' });
    const job = jobTracker.createJob(id, 'image', idx);
    res.json({ jobId: job.id });

    // Background image gen. Errors land in the shot status + job tracker;
    // never bubbled to res (it's already been sent).
    (async () => {
      try {
        jobTracker.updateJob(job.id, { status: 'running', progress: 0.1 });
        repo.updateShot(id, idx, { status: 'generating' });
        const updatedShotEarly = repo.getShot(id, idx);
        if (updatedShotEarly) {
          emit({ type: 'videoboard:shot:updated', projectId: id, shot: updatedShotEarly });
        }

        const { imageUrl, promptId, templateName } = await runShotImageGen({
          project,
          shot,
          templateNameOverride,
        });

        repo.updateShot(id, idx, {
          imageUrl,
          imagePromptId: promptId,
          status: 'ready',
        });
        jobTracker.updateJob(job.id, {
          status: 'done',
          progress: 1.0,
          outputUrl: imageUrl,
          message: `prompt=${promptId}; template=${templateName}`,
        });
        const updatedShot = repo.getShot(id, idx);
        if (updatedShot) emit({ type: 'videoboard:shot:updated', projectId: id, shot: updatedShot });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Cancelled-by-user (rerun replaces the previous) shouldn't poison the
        // job log — it's expected. But we still flip the shot back to pending
        // so the modal shows the canonical "not generating" state.
        const isCancel = err instanceof ComfyJobCancelledError;
        const isExecErr = err instanceof ComfyJobExecutionError;
        repo.updateShot(id, idx, { status: isCancel ? 'pending' : 'error' });
        jobTracker.updateJob(job.id, {
          status: isCancel ? 'done' : 'error',
          message: isCancel ? 'cancelled (replaced by another run)' : msg,
        });
        const updatedShot = repo.getShot(id, idx);
        if (updatedShot) emit({ type: 'videoboard:shot:updated', projectId: id, shot: updatedShot });
        if (!isCancel && !isExecErr) {
          // Unexpected — keep the trace handy for tail -f /app/logs/studio.log
          console.error('[videoboard.shotImage] unexpected error:', err);
        }
      }
    })();
  } catch (err) { sendError(res, err, 500, 'Image generation failed'); }
});

// POST /api/videoboard/projects/:id/shots/images/generate-all
// Queue image gen for every shot that doesn't already have an image and isn't
// already in flight. Returns immediately with the list of queued shot indices.
//
// Processing strategy: shots are processed SERIALLY in the background. We
// don't fan out parallel ComfyUI submits because (a) there's one GPU on the
// pod and ComfyUI would just queue them anyway, and (b) the WS bridge stays
// cleaner with at most one tracked prompt at a time. Total wall time for a
// full 39-shot storyboard on FLUX.2 Klein 9B is ~20 minutes.
//
// Body: { templateName? } — applies to every shot in this batch (per-shot
// overrides still win if the shot has its own imageTemplateName set).
router.post('/videoboard/projects/:id/shots/images/generate-all', (req: Request, res: Response): void => {
  try {
    const id = req.params.id as string;
    const project = repo.getProject(id);
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    if (project.shots.length === 0) {
      res.status(400).json({ error: 'No shots to generate — run Analyze + Generate Storyboard first.' });
      return;
    }

    const body = (req.body ?? {}) as { templateName?: unknown };
    const batchTemplateName = typeof body.templateName === 'string' && body.templateName.length > 0
      ? body.templateName
      : undefined;

    // Eligibility: missing image AND not already in flight. A shot in 'error'
    // status IS eligible (retry from prior failure).
    // The `isInflight()` check is the load-bearing guard against the double-
    // submit bug: if a previous generate-all is still working through the
    // queue, its per-shot AbortControllers are alive. Without this check, a
    // second click would call runShotImageGen for each shot, which calls
    // cancelInflight() — killing the previous batch's trackers while the
    // ComfyUI prompts keep rendering and land as orphan images in Gallery.
    const eligible = project.shots.filter(
      (s) => !s.imageUrl
        && s.status !== 'generating'
        && s.status !== 'queued'
        && !isInflight(id, s.idx),
    );
    if (eligible.length === 0) {
      res.json({ queued: [], skipped: project.shots.length, message: 'All shots already have images or are in flight.' });
      return;
    }

    // Flip all eligible shots to 'queued' immediately so the UI reflects the
    // batch state before any GPU work starts.
    for (const s of eligible) {
      repo.updateShot(id, s.idx, { status: 'queued' });
      const updated = repo.getShot(id, s.idx);
      if (updated) emit({ type: 'videoboard:shot:updated', projectId: id, shot: updated });
    }

    res.json({ queued: eligible.map((s) => s.idx), skipped: project.shots.length - eligible.length });

    // Parallel submit, sequential GPU execution by ComfyUI itself.
    //
    // Each shot fires off its own async pipeline (runShotImageGen). All N
    // submissions hit ComfyUI's `/api/prompt` within milliseconds; ComfyUI's
    // OWN queue then serializes them on the single GPU. The user sees the
    // queue grow in ComfyUI's `/api/queue` and shrink as runs complete.
    //
    // We do NOT await each one before submitting the next — the old serial
    // loop hung the entire batch on a single failed bridge tracker, which
    // is exactly the bug that triggered this rewrite.
    for (const queuedShot of eligible) {
      void (async () => {
        const liveProject = repo.getProject(id);
        if (!liveProject) return;
        const liveShot = liveProject.shots.find((s) => s.idx === queuedShot.idx);
        if (!liveShot) return;

        const job = jobTracker.createJob(id, 'image', queuedShot.idx);
        try {
          jobTracker.updateJob(job.id, { status: 'running', progress: 0.1 });
          repo.updateShot(id, queuedShot.idx, { status: 'generating' });
          const earlyShot = repo.getShot(id, queuedShot.idx);
          if (earlyShot) emit({ type: 'videoboard:shot:updated', projectId: id, shot: earlyShot });

          const { imageUrl, promptId, templateName } = await runShotImageGen({
            project: liveProject,
            shot: liveShot,
            templateNameOverride: batchTemplateName,
          });

          repo.updateShot(id, queuedShot.idx, {
            imageUrl,
            imagePromptId: promptId,
            status: 'ready',
          });
          jobTracker.updateJob(job.id, {
            status: 'done',
            progress: 1.0,
            outputUrl: imageUrl,
            message: `prompt=${promptId}; template=${templateName}; batch`,
          });
          const updatedShot = repo.getShot(id, queuedShot.idx);
          if (updatedShot) emit({ type: 'videoboard:shot:updated', projectId: id, shot: updatedShot });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const isCancel = err instanceof ComfyJobCancelledError;
          repo.updateShot(id, queuedShot.idx, { status: isCancel ? 'pending' : 'error' });
          jobTracker.updateJob(job.id, {
            status: isCancel ? 'done' : 'error',
            message: isCancel ? 'cancelled (replaced by another run)' : msg,
          });
          const updatedShot = repo.getShot(id, queuedShot.idx);
          if (updatedShot) emit({ type: 'videoboard:shot:updated', projectId: id, shot: updatedShot });
        }
      })();
    }
  } catch (err) { sendError(res, err, 500, 'Generate-all failed'); }
});

// POST /api/videoboard/projects/:id/shots/:idx/animate
// Generates an LTX FLF2V video for a single shot using its image as the
// first frame and the NEXT shot's image as the last frame. The last shot
// (idx === shots.length - 1) has no next shot, so it's rejected with 400.
router.post('/videoboard/projects/:id/shots/:idx/animate', (req: Request, res: Response): void => {
  try {
    const id = req.params.id as string;
    const idx = Number(req.params.idx);
    const project = repo.getProject(id);
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    const shot = project.shots.find(s => s.idx === idx);
    if (!shot) { res.status(404).json({ error: 'Shot not found' }); return; }
    const nextShot = project.shots.find(s => s.idx === idx + 1);
    if (!nextShot) {
      res.status(400).json({ error: 'Last shot has no next frame; video generation is skipped for the final shot.' });
      return;
    }
    if (!shot.imageUrl) {
      res.status(400).json({ error: 'Shot has no image yet — generate the still image first.' });
      return;
    }
    if (!nextShot.imageUrl) {
      res.status(400).json({ error: `Next shot (${nextShot.idx}) has no image yet — generate it first to use as the last frame.` });
      return;
    }

    const body = (req.body ?? {}) as { templateName?: unknown };
    const templateNameOverride = typeof body.templateName === 'string' && body.templateName.length > 0
      ? body.templateName
      : undefined;

    repo.updateShot(id, idx, { status: 'queued' });
    const job = jobTracker.createJob(id, 'video', idx);
    res.json({ jobId: job.id });

    (async () => {
      try {
        jobTracker.updateJob(job.id, { status: 'running', progress: 0.1 });
        repo.updateShot(id, idx, { status: 'generating' });
        const early = repo.getShot(id, idx);
        if (early) emit({ type: 'videoboard:shot:updated', projectId: id, shot: early });

        const { videoUrl, promptId, templateName, frames } = await runShotVideoGen({
          project,
          shot,
          nextShot,
          templateNameOverride,
        });

        repo.updateShot(id, idx, { videoUrl, status: 'ready' });
        jobTracker.updateJob(job.id, {
          status: 'done',
          progress: 1.0,
          outputUrl: videoUrl,
          message: `prompt=${promptId}; template=${templateName}; frames=${frames}`,
        });
        const updated = repo.getShot(id, idx);
        if (updated) emit({ type: 'videoboard:shot:updated', projectId: id, shot: updated });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isCancel = err instanceof ComfyJobCancelledError;
        const isExecErr = err instanceof ComfyJobExecutionError;
        repo.updateShot(id, idx, { status: isCancel ? 'ready' : 'error' });
        jobTracker.updateJob(job.id, {
          status: isCancel ? 'done' : 'error',
          message: isCancel ? 'cancelled (replaced by another run)' : msg,
        });
        const updated = repo.getShot(id, idx);
        if (updated) emit({ type: 'videoboard:shot:updated', projectId: id, shot: updated });
        if (!isCancel && !isExecErr) {
          console.error('[videoboard.shotVideo] unexpected error:', err);
        }
      }
    })();
  } catch (err) { sendError(res, err, 500, 'Animate failed'); }
});

// POST /api/videoboard/projects/:id/shots/videos/generate-all
// Queue video gen for every shot that has an image, has a NEXT shot with an
// image, doesn't already have a video, and isn't currently in flight. The
// last shot is intentionally skipped (no next frame).
router.post('/videoboard/projects/:id/shots/videos/generate-all', (req: Request, res: Response): void => {
  try {
    const id = req.params.id as string;
    const project = repo.getProject(id);
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    if (project.shots.length < 2) {
      res.status(400).json({ error: 'Need at least 2 shots for FLF2V video generation.' });
      return;
    }

    const body = (req.body ?? {}) as { templateName?: unknown };
    const batchTemplateName = typeof body.templateName === 'string' && body.templateName.length > 0
      ? body.templateName
      : undefined;

    const shotsByIdx = new Map(project.shots.map(s => [s.idx, s]));
    const eligible = project.shots.filter((s) => {
      if (s.idx === project.shots.length - 1) return false;  // last shot has no next
      if (!s.imageUrl) return false;
      const next = shotsByIdx.get(s.idx + 1);
      if (!next || !next.imageUrl) return false;
      if (s.videoUrl) return false;
      if (s.status === 'generating' || s.status === 'queued') return false;
      if (isVideoInflight(id, s.idx)) return false;
      return true;
    });
    if (eligible.length === 0) {
      res.json({ queued: [], skipped: project.shots.length, message: 'No shots eligible — all have videos already, or images missing, or in flight.' });
      return;
    }

    for (const s of eligible) {
      repo.updateShot(id, s.idx, { status: 'queued' });
      const u = repo.getShot(id, s.idx);
      if (u) emit({ type: 'videoboard:shot:updated', projectId: id, shot: u });
    }

    res.json({ queued: eligible.map(s => s.idx), skipped: project.shots.length - eligible.length });

    // Fire all submissions; ComfyUI serializes them on the single GPU.
    for (const queuedShot of eligible) {
      void (async () => {
        const liveProject = repo.getProject(id);
        if (!liveProject) return;
        const liveShot = liveProject.shots.find(s => s.idx === queuedShot.idx);
        const liveNext = liveProject.shots.find(s => s.idx === queuedShot.idx + 1);
        if (!liveShot || !liveNext) return;

        const job = jobTracker.createJob(id, 'video', queuedShot.idx);
        try {
          jobTracker.updateJob(job.id, { status: 'running', progress: 0.1 });
          repo.updateShot(id, queuedShot.idx, { status: 'generating' });
          const early = repo.getShot(id, queuedShot.idx);
          if (early) emit({ type: 'videoboard:shot:updated', projectId: id, shot: early });

          const { videoUrl, promptId, templateName, frames } = await runShotVideoGen({
            project: liveProject,
            shot: liveShot,
            nextShot: liveNext,
            templateNameOverride: batchTemplateName,
          });
          repo.updateShot(id, queuedShot.idx, { videoUrl, status: 'ready' });
          jobTracker.updateJob(job.id, {
            status: 'done',
            progress: 1.0,
            outputUrl: videoUrl,
            message: `prompt=${promptId}; template=${templateName}; frames=${frames}; batch`,
          });
          const updated = repo.getShot(id, queuedShot.idx);
          if (updated) emit({ type: 'videoboard:shot:updated', projectId: id, shot: updated });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const isCancel = err instanceof ComfyJobCancelledError;
          repo.updateShot(id, queuedShot.idx, { status: isCancel ? 'ready' : 'error' });
          jobTracker.updateJob(job.id, {
            status: isCancel ? 'done' : 'error',
            message: isCancel ? 'cancelled (replaced by another run)' : msg,
          });
          const updated = repo.getShot(id, queuedShot.idx);
          if (updated) emit({ type: 'videoboard:shot:updated', projectId: id, shot: updated });
        }
      })();
    }
  } catch (err) { sendError(res, err, 500, 'Generate-all videos failed'); }
});

// POST /api/videoboard/projects/:id/shots/chain/generate
// SERIAL LTX-2.3 latent-chain video generation across a contiguous slice of
// shots. The chain template (`video_ltx2_3_chain`) wraps the standard LTX
// pipeline with a LatentSwitch + SaveLatent/LoadLatent pair: shot 0 (or any
// `startIdx`) runs the full image→video path and writes its final AV latent
// to disk; each subsequent shot loads its predecessor's latent, skips the
// image branch + base sampler entirely, and writes its own latent for the
// next shot.
//
// Body:
//   - startIdx?: number             (default 0)
//   - stopIdx?: number              (default shots.length - 1, INCLUSIVE)
//   - startingImageUrl?: string     view URL of the seed image for `startIdx`.
//                                   Required when the shot at startIdx has no
//                                   imageUrl on its row (e.g. fresh chain on
//                                   un-imaged shots). When the row already has
//                                   one, it is used as the fallback.
//   - templateName?: string         override; defaults to `video_ltx2_3_chain`.
//
// Returns immediately with a single jobId for the whole chain. WS events
// (`videoboard:shot:updated`) fire per-shot as each completes.
//
// Why serial: each shot's submit depends on the PREVIOUS shot's SaveLatent
// landing on disk. There is no point pipelining — the GPU is shared and the
// next prompt cannot be constructed until the previous one's history entry
// is materialized.
//
// Cancellation: re-posting to the same project starts a new chain. The
// per-shot AbortControllers in runShotVideoChainGen get cancelled for the
// in-flight shot via cancelInflight on its next submit. We do NOT track the
// chain itself as a single cancellable unit — keeping the same surface as
// generate-all.
router.post('/videoboard/projects/:id/shots/chain/generate', (req: Request, res: Response): void => {
  try {
    const id = req.params.id as string;
    const project = repo.getProject(id);
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    if (project.shots.length === 0) {
      res.status(400).json({ error: 'No shots to generate — run Analyze + Generate Storyboard first.' });
      return;
    }

    const body = (req.body ?? {}) as {
      startIdx?: unknown;
      stopIdx?: unknown;
      startingImageUrl?: unknown;
      templateName?: unknown;
    };
    const startIdx = Number.isInteger(body.startIdx) ? Number(body.startIdx) : 0;
    const lastIdx = project.shots.length - 1;
    const stopIdx = Number.isInteger(body.stopIdx) ? Number(body.stopIdx) : lastIdx;
    const startingImageUrl = typeof body.startingImageUrl === 'string' && body.startingImageUrl.length > 0
      ? body.startingImageUrl : undefined;
    const templateNameOverride = typeof body.templateName === 'string' && body.templateName.length > 0
      ? body.templateName : undefined;

    if (startIdx < 0 || startIdx > lastIdx) {
      res.status(400).json({ error: `startIdx ${startIdx} out of range [0..${lastIdx}]` });
      return;
    }
    if (stopIdx < startIdx || stopIdx > lastIdx) {
      res.status(400).json({ error: `stopIdx ${stopIdx} must be in [${startIdx}..${lastIdx}]` });
      return;
    }

    // Bootstrap: shot at startIdx needs SOMETHING to seed the image branch
    // off of. We pick, in order of preference:
    //   1. caller-supplied startingImageUrl (explicit override)
    //   2. existing shot.imageUrl on the startIdx shot
    //   3. error — no seed available
    // We do NOT auto-call runShotImageGen here. Generating a still is a
    // user-visible action with its own job lifecycle; quietly firing it
    // inside a chain run would confuse the UI's job tracker and bury the
    // failure mode (no image template configured, GPU OOM, etc.) inside an
    // unrelated chain job. Caller must seed first.
    const seedShot = project.shots.find(s => s.idx === startIdx);
    if (!seedShot) {
      res.status(400).json({ error: `Shot ${startIdx} not found in project` });
      return;
    }
    // Image requirement: chain mode still needs ANY image for the upstream
    // ResizeImageMaskNode placeholder. In resume mode (predecessor has a
    // saved latent) we'll use the startIdx shot's own image if present, then
    // the caller's override, then the predecessor's image — anything works
    // as a placeholder. In fresh-bootstrap mode (no predecessor latent) the
    // image actually drives the first sampler so it MUST come from the
    // caller or the shot row.
    const predShotForImg = startIdx > 0
      ? project.shots.find(s => s.idx === startIdx - 1)
      : undefined;
    const seedImageUrl =
      startingImageUrl
      ?? seedShot.imageUrl
      ?? (predShotForImg && predShotForImg.imageUrl)
      ?? undefined;
    if (!seedImageUrl) {
      res.status(400).json({
        error: `Shot ${startIdx} has no image and no startingImageUrl was provided. Generate the still image for the first shot first, or pass startingImageUrl in the body.`,
      });
      return;
    }

    // Flip all shots in the range to 'queued' so the UI reflects the batch.
    for (let i = startIdx; i <= stopIdx; i++) {
      if (isVideoChainInflight(id, i)) {
        res.status(409).json({ error: `Shot ${i} already has a chain run in flight` });
        return;
      }
      repo.updateShot(id, i, { status: 'queued' });
      const u = repo.getShot(id, i);
      if (u) emit({ type: 'videoboard:shot:updated', projectId: id, shot: u });
    }

    const job = jobTracker.createJob(id, 'video');
    res.json({ jobId: job.id, startIdx, stopIdx, shotCount: stopIdx - startIdx + 1 });

    // Background serial chain loop using LAST-FRAME EXTRACTION (not the
    // earlier broken latent-passthrough). Each iteration:
    //   1. Re-fetch the live shot row.
    //   2. For shot at startIdx: use seedImageUrl as the starting frame.
    //      For shot N>startIdx: use the URL of the PNG we extracted from
    //      shot N-1's video (ffmpeg) as the starting frame. The model runs
    //      the full i2v pipeline conditioned on that visible last frame.
    //   3. After completion, runShotVideoChainGen returns lastFrameUrl
    //      pointing at the PNG it extracted from THIS shot's video.
    //   4. Carry lastFrameUrl forward as the next iteration's prevVideoUrl
    //      pseudo-source — actually, we pass it as startingImageUrl and skip
    //      the ffmpeg redo by using the precomputed lastFrameUrl directly
    //      via prevVideoUrl=undefined and the staged PNG file path.
    // Resume support: if startIdx > 0 AND the predecessor shot has a
    // videoUrl, we DO want shot at startIdx to chain from its last frame.
    // We pass the predecessor's videoUrl as prevVideoUrl on the first
    // iteration so the helper extracts and stages it.
    let bootstrapPrevVideoUrl: string | undefined;
    if (startIdx > 0) {
      const predShot = project.shots.find(s => s.idx === startIdx - 1);
      if (predShot?.videoUrl) {
        bootstrapPrevVideoUrl = predShot.videoUrl;
      }
    }

    // For resume: also pull predecessor's keyVisual so the FIRST iteration's
    // prompt gets the "Continuing from:" prefix. Without this, the first
    // resumed shot has no narrative bridge to the prev shot.
    let bootstrapPrevKeyVisual: string | undefined;
    if (startIdx > 0) {
      const predShot = project.shots.find((s) => s.idx === startIdx - 1);
      bootstrapPrevKeyVisual = predShot?.keyVisual;
    }

    (async () => {
      // First iteration uses either a fresh seed image OR (in resume mode)
      // the predecessor's video. After that, every iteration's prevVideo
      // is just the PREVIOUS iteration's videoUrl result.
      let prevVideoUrl: string | undefined = bootstrapPrevVideoUrl;
      let prevKeyVisual: string | undefined = bootstrapPrevKeyVisual;
      let resolvedSeedImageUrl: string | undefined = seedImageUrl;
      jobTracker.updateJob(job.id, { status: 'running', progress: 0.05 });

      // Self-heal: if shot at startIdx's image_url points at a deleted file
      // (common after orphan cleanup or output rotation), regenerate the
      // still BEFORE submitting any chain video. Matches user expectation
      // that "Generate Video Chain starting from shot 0" should just work
      // even if no images are on disk — frame 0 IS a fresh start.
      // Skipped when resuming from a prev video (no seed needed there).
      if (!prevVideoUrl && !viewUrlPointsToExistingFile(resolvedSeedImageUrl)) {
        try {
          jobTracker.updateJob(job.id, {
            status: 'running',
            progress: 0.02,
            message: `shot ${startIdx} seed image missing on disk — regenerating still`,
          });
          repo.updateShot(id, startIdx, { status: 'generating' });
          const early = repo.getShot(id, startIdx);
          if (early) emit({ type: 'videoboard:shot:updated', projectId: id, shot: early });

          const imgResult = await runShotImageGen({
            project,
            shot: seedShot,
          });
          repo.updateShot(id, startIdx, {
            imageUrl: imgResult.imageUrl,
            imagePromptId: imgResult.promptId,
          });
          const updated = repo.getShot(id, startIdx);
          if (updated) emit({ type: 'videoboard:shot:updated', projectId: id, shot: updated });
          resolvedSeedImageUrl = imgResult.imageUrl;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          repo.updateShot(id, startIdx, { status: 'error' });
          const updated = repo.getShot(id, startIdx);
          if (updated) emit({ type: 'videoboard:shot:updated', projectId: id, shot: updated });
          // Reset every shot in the chain back to pending so the UI isn't lying.
          for (let j = startIdx + 1; j <= stopIdx; j++) {
            repo.updateShot(id, j, { status: 'pending' });
            const u = repo.getShot(id, j);
            if (u) emit({ type: 'videoboard:shot:updated', projectId: id, shot: u });
          }
          jobTracker.updateJob(job.id, {
            status: 'error',
            message: `seed image regeneration failed for shot ${startIdx}: ${msg}`,
          });
          return;
        }
      }

      let imageUrlForThisStep: string | undefined = prevVideoUrl ? undefined : resolvedSeedImageUrl;

      for (let i = startIdx; i <= stopIdx; i++) {
        const liveProject = repo.getProject(id);
        if (!liveProject) {
          jobTracker.updateJob(job.id, { status: 'error', message: 'project deleted mid-chain' });
          return;
        }
        const liveShot = liveProject.shots.find(s => s.idx === i);
        if (!liveShot) {
          jobTracker.updateJob(job.id, {
            status: 'error',
            message: `shot ${i} disappeared mid-chain`,
          });
          return;
        }

        try {
          repo.updateShot(id, i, { status: 'generating' });
          const early = repo.getShot(id, i);
          if (early) emit({ type: 'videoboard:shot:updated', projectId: id, shot: early });

          const result = await runShotVideoChainGen({
            project: liveProject,
            shot: liveShot,
            prevVideoUrl,
            prevKeyVisual,
            startingImageUrl: imageUrlForThisStep,
            templateNameOverride,
          });

          repo.updateShot(id, i, {
            videoUrl: result.videoUrl,
            status: 'ready',
          });
          const updated = repo.getShot(id, i);
          if (updated) emit({ type: 'videoboard:shot:updated', projectId: id, shot: updated });

          // Carry forward: next iteration chains off THIS shot's video AND
          // gets this shot's keyVisual as the narrative bridge.
          prevVideoUrl = result.videoUrl;
          prevKeyVisual = liveShot.keyVisual;
          imageUrlForThisStep = undefined;

          const progress = (i - startIdx + 1) / (stopIdx - startIdx + 1);
          jobTracker.updateJob(job.id, {
            status: i === stopIdx ? 'done' : 'running',
            progress,
            outputUrl: result.videoUrl,
            message: `shot ${i}: prompt=${result.promptId}; lastFrame=${result.lastFrameUrl}; frames=${result.frames}`,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const isCancel = err instanceof ComfyJobCancelledError;
          repo.updateShot(id, i, { status: isCancel ? 'pending' : 'error' });
          const updated = repo.getShot(id, i);
          if (updated) emit({ type: 'videoboard:shot:updated', projectId: id, shot: updated });
          // Flip remaining shots back to pending — they were 'queued' from the
          // pre-flight loop, but the chain stops here so leaving them queued
          // forever would be a lie.
          for (let j = i + 1; j <= stopIdx; j++) {
            repo.updateShot(id, j, { status: 'pending' });
            const u = repo.getShot(id, j);
            if (u) emit({ type: 'videoboard:shot:updated', projectId: id, shot: u });
          }
          jobTracker.updateJob(job.id, {
            status: isCancel ? 'done' : 'error',
            message: isCancel
              ? `cancelled at shot ${i} (replaced by another run)`
              : `failed at shot ${i}: ${msg}`,
          });
          if (!isCancel && !(err instanceof ComfyJobExecutionError)) {
            console.error('[videoboard.shotVideoChain] unexpected error:', err);
          }
          return;
        }
      }
    })();
  } catch (err) { sendError(res, err, 500, 'Chain generation failed'); }
});

// POST /api/videoboard/projects/:id/render
router.post('/videoboard/projects/:id/render', (req: Request, res: Response): void => {
  try {
    const id = req.params.id as string;
    const project = repo.getProject(id);
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    repo.updateProject(id, { status: 'generating' });
    const job = jobTracker.createJob(id, 'render');

    // TODO: wire real ffmpeg composition for final render.
    setTimeout(() => {
      jobTracker.updateJob(job.id, { status: 'running', progress: 0.5 });
    }, 1000);

    setTimeout(() => {
      const outputUrl = '/placeholder-render.mp4';
      repo.updateProject(id, { status: 'ready' });
      jobTracker.updateJob(job.id, { status: 'done', progress: 1.0, outputUrl });
      const updated = repo.getProject(id);
      if (updated) emit({ type: 'videoboard:project:updated', project: updated });
    }, 3000);

    res.json({ jobId: job.id });
  } catch (err) { sendError(res, err, 500, 'Render failed'); }
});

export default router;
