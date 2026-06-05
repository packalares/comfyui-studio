// Videoboard router composition root.
// Mounts all sub-routers: projects, shots, jobs (+ SSE stream).
// Also owns the WS broadcast function that threads through to sub-routers.

import { Router } from 'express';
import {
  listProjectsRoute,
  createProjectRoute,
  getProjectRoute,
  updateProjectRoute,
  deleteProjectRoute,
  getAnalysisRoute,
  analyzeRoute,
  generateStoryboardRoute,
  registerAudioRoutes,
  setProjectsEmitter,
} from './videoboard.projects.routes.js';
import {
  updateShotRoute,
  generateShotImageRoute,
  generateAllImagesRoute,
  animateShotRoute,
  generateAllVideosRoute,
  generateChainRoute,
  setShotsEmitter,
} from './videoboard.shots.routes.js';
import {
  getJobRoute,
  registerJobStreamRoute,
  setJobUpdateSubscriber,
} from './videoboard.jobs.routes.js';
import { renderProjectRoute, setRenderEmitter } from './videoboard.render.routes.js';
import type { JobRecord } from '../contracts/videoboard.js';
import * as repo from '../lib/db/videoboard.repo.js';

// ---- WS broadcaster re-export (set by index.ts) -----------------------------

let _broadcast: ((payload: object) => void) | null = null;

export function setVideoboardRouteBroadcaster(fn: ((payload: object) => void) | null): void {
  _broadcast = fn;
  setProjectsEmitter(fn);
  setShotsEmitter(fn);
  // Wire the job update subscriber: when the broadcast fires a videoboard:job
  // event, route it to any active SSE streams that are watching that jobId.
  // We use a simple listener registry here — the SSE stream manages its own
  // lifecycle (unsubscribes via onClose).
  const listeners = new Map<string, Set<(job: JobRecord) => void>>();
  setJobUpdateSubscriber((jobId, cb) => {
    // Immediately fire with current state so the subscriber catches up.
    const current = repo.getJob(jobId);
    if (current) cb(current);
    let set = listeners.get(jobId);
    if (!set) { set = new Set(); listeners.set(jobId, set); }
    set.add(cb);
    return () => {
      const s = listeners.get(jobId);
      if (s) { s.delete(cb); if (s.size === 0) listeners.delete(jobId); }
    };
  });
  // Intercept the broadcast to also fire per-job SSE listeners.
  // We patch a wrapper so the original broadcast still goes to WS clients.
  if (fn) {
    const original = fn;
    const wrapped = (payload: object): void => {
      original(payload);
      const msg = payload as { type?: string; record?: JobRecord };
      if (msg.type === 'videoboard:job' && msg.record) {
        const s = listeners.get(msg.record.id);
        if (s) s.forEach((cb) => cb(msg.record!));
      }
    };
    _broadcast = wrapped;
    setProjectsEmitter(wrapped);
    setShotsEmitter(wrapped);
    setRenderEmitter(wrapped);
  } else {
    setRenderEmitter(fn);
  }
}

function emit(payload: object): void {
  if (_broadcast) _broadcast(payload);
}
// Export for index.ts compatibility (legacy stubs also call emit).
export { emit };

// ---- Router assembly --------------------------------------------------------

const router = Router();

// Projects
listProjectsRoute.register(router);
createProjectRoute.register(router);
getProjectRoute.register(router);
updateProjectRoute.register(router);
deleteProjectRoute.register(router);

// Audio (multer, registered manually)
registerAudioRoutes(router);

// Analysis / storyboard
getAnalysisRoute.register(router);
analyzeRoute.register(router);
generateStoryboardRoute.register(router);

// Shots
updateShotRoute.register(router);
generateShotImageRoute.register(router);
generateAllImagesRoute.register(router);
animateShotRoute.register(router);
generateAllVideosRoute.register(router);
generateChainRoute.register(router);

// Jobs (poll + SSE stream)
getJobRoute.register(router);
registerJobStreamRoute(router);

// Render
renderProjectRoute.register(router);

export default router;
