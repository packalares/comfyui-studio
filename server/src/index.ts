import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import apiRouter from './routes/index.js';
import { getComfyUIUrl, getQueue, getQueuePromptIds } from './services/comfyui/api.js';
import * as galleryService from './services/gallery/index.js';
import { hydrateFromQueue, onQueueStatus } from './services/gallery/sentry.js';
import { wireTemplateEventHandlers } from './services/templates/eventSubscribers.js';
import { wireCatalogEventHandlers } from './services/catalog/index.js';
import { migrateCatalogIfNeeded } from './services/catalog/migrate.js';
import { refreshRegistry } from './services/catalog/folderRegistry.js';
import {
  ensureFresh as ensureModelIndexFresh,
  wireModelIndexEventHandlers,
} from './services/models/modelIndex.js';
import { setDownloadBroadcaster, getAllDownloads } from './services/downloads/index.js';
import { setOllamaPullBus } from './services/downloads/ollamaPullAdapter.js';
import { setChatBroadcaster } from './services/chat/broadcaster.js';
import { setVideoboardBroadcaster } from './services/videoboard/jobTracker.js';
import { setVideoboardRouteBroadcaster } from './routes/videoboard.routes.js';
import { setPackBroadcaster } from './services/packs/install.js';
import { setAceBroadcaster } from './services/ace/broadcaster.js';
import { setAiToolkitBroadcaster } from './services/aiToolkit/train.js';
import { sweepStaleUploads } from './routes/upload.routes.js';
import * as promptSnapshotsRepo from './lib/db/promptSnapshots.repo.js';
import { getStatus as getLocalComfyUIStatus } from './services/comfyui/status.js';
import { startComfyUIProxy } from './services/comfyui/proxy.js';
import { env } from './config/env.js';
import { migrateLegacyPaths } from './config/migrateLegacyPaths.js';
import { requestLogger } from './middleware/logging.js';
import { errorHandler } from './middleware/errors.js';
import { rateLimit } from './middleware/rateLimit.js';
import { pickNotFoundMessage } from './lib/notFoundMessages.js';
import { logger } from './lib/logger.js';
import { warnRoutesMissingAuth } from './lib/defineRoute.js';
import { getMasterKey, matchesMasterKey } from './lib/auth/masterKey.js';
import {
  classifySameOrigin,
  readSessionCookieFromHeaders,
} from './lib/auth/session.js';
import { extractPrefix, verifyKey } from './lib/auth/keyGen.js';
import { getApiKeyByPrefix, touchApiKey } from './lib/db/apiKeys.repo.js';
import { scheduler } from './services/gpu/scheduler.js';
import { registerPreviewHook } from './services/models/enrichment/previewHook.js';
import { registerEnrichmentWsHook } from './services/models/enrichment/wsHook.js';

// Phase-6 path consolidation: move runtime-written JSON out of the bundled
// data dir and into `~/.config/comfyui-studio/runtime/` so it survives image
// rebuilds. No-op once migrated.
migrateLegacyPaths();

// Load (or first-boot generate) the master key now so any later module that
// reads it gets a warm cache. The key file lives under runtimeStateDir.
getMasterKey();

const app = express();
const PORT = env.PORT;

// CORS: default allow-all matches pod-internal behavior. When CORS_ORIGIN is
// set (e.g. a public deployment), lock down to the declared origin(s).
const corsOrigins = env.CORS_ORIGIN
  ? env.CORS_ORIGIN.split(',').map(s => s.trim()).filter(Boolean)
  : undefined;
app.use(cors(corsOrigins ? { origin: corsOrigins } : undefined));
app.use(express.json({ limit: '50mb' }));
app.use(requestLogger());

// Global rate limiter — every /api/* call gets the 'default' profile.
// Trusted-UI requests (master cookie + same-origin) bypass entirely; only
// external Bearer-key callers consume buckets. Per-route tighter profiles
// (rateLimit('plugins:write') etc.) stack on top and bite first.
//
// `/view` is exempt: it's a static-asset-style proxy (thumbnail / preview
// images, audio, video). An image-heavy modal — MediaLibraryModal's
// output gallery in particular — can fire dozens of /view per scroll
// tick. The default 300/min cap turns that into 429s that look like the
// server is down. The route already enforces path-traversal protection
// + a header cap, so skipping the rate bucket is safe.
const defaultLimiter = rateLimit('default');
app.use('/api', (req, res, next) => {
  if (req.path === '/view') { next(); return; }
  defaultLimiter(req, res, next);
});

app.use('/api', apiRouter);

// Audit defineRoute routes for missing `auth` declarations. Wave 2 wires the
// auth middleware; until then we surface the gap as one warning per route so
// nothing ships silently un-gated.
warnRoutesMissingAuth();

// 404 fallback for unknown /api routes. Returns JSON (matches the rest of
// the API) with a randomly-picked message from `lib/notFoundMessages` —
// no path echo, so responses don't enumerate which routes exist for anyone
// probing the surface.
app.use('/api', (_req, res) => {
  res.status(404).json({ error: pickNotFoundMessage() });
});

import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(__dirname, '../../dist');
app.use(express.static(distPath));
app.get('*', (_req, res, next) => {
  if (_req.path.startsWith('/api') || _req.path.startsWith('/ws')) return next();
  res.sendFile(path.join(distPath, 'index.html'));
});

// Install the error handler LAST. Express picks up 4-arg middleware only
// when `next(err)` is called, so this catches anything routes throw.
app.use(errorHandler());

const server = createServer(app);

// WS upgrade auth — mirrors the HTTP auth middleware so /ws can't bypass it.
//
// Decision flow (same as middleware/auth.ts):
//   1. Session cookie matches master + sec-site != cross-site → accept (UI)
//   2. No (valid) cookie but same-origin signal strong/weak → accept (first-visit UI;
//      the cookie itself lands on the next HTTP request via auth middleware)
//   3. Authorization: Bearer sk_… with ws:connect (or admin:all) scope → accept
//   4. otherwise → reject 401
//
// WS_ORIGIN env, if set, narrows what counts as 'same-origin' to an explicit
// allow-list. Unset preserves the pod-internal behaviour.
const wsOriginAllowlist = env.WS_ORIGIN
  ? new Set(env.WS_ORIGIN.split(',').map(s => s.trim()).filter(Boolean))
  : null;

function wsVerify(
  info: { origin: string; req: import('http').IncomingMessage },
  cb: (ok: boolean, code?: number, message?: string) => void,
): void {
  const req = info.req;

  if (wsOriginAllowlist && !wsOriginAllowlist.has(info.origin || '')) {
    cb(false, 401, 'Unauthorized'); return;
  }

  const sig = classifySameOrigin(req.headers);
  const cookie = readSessionCookieFromHeaders(req.headers);

  if (matchesMasterKey(cookie)) {
    if (sig === 'reject') { cb(false, 401, 'Unauthorized'); return; }
    cb(true); return;
  }
  if (sig === 'strong' || sig === 'weak') {
    cb(true); return;
  }

  const authHeader = req.headers['authorization'];
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const plain = authHeader.slice('Bearer '.length).trim();
    const prefix = extractPrefix(plain);
    if (!prefix) { cb(false, 401, 'Unauthorized'); return; }
    const row = getApiKeyByPrefix(prefix);
    if (!row || row.revokedAt !== null) { cb(false, 401, 'Unauthorized'); return; }
    if (row.expiresAt !== null && row.expiresAt < Date.now()) {
      cb(false, 401, 'Unauthorized'); return;
    }
    if (!verifyKey(plain, row.hash)) { cb(false, 401, 'Unauthorized'); return; }
    const scopes = new Set(row.scopes);
    if (!scopes.has('admin:all') && !scopes.has('ws:connect')) {
      cb(false, 403, 'Forbidden'); return;
    }
    touchApiKey(row.id);
    cb(true); return;
  }

  cb(false, 401, 'Unauthorized');
}

const wss = new WebSocketServer({
  server,
  path: '/ws',
  verifyClient: wsVerify,
});

// ---- Track connected clients for broadcast ----
const clients = new Set<WebSocket>();

function broadcast(message: object) {
  const data = JSON.stringify(message);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

// Forward raw ComfyUI JSON strings verbatim to every open browser client.
// Distinct from broadcast() which serialises Studio-internal objects — these
// strings are already serialised and must not be double-encoded.
function broadcastRaw(json: string) {
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(json);
  }
}

// Forward binary ComfyUI frames (live-preview blobs during sampling) to
// every connected client. ComfyUI emits these as binary WS frames with an
// 8-byte header (uint32 type=1 + uint32 image_type, see KSampler preview
// path); the client decodes them. We pass-through unchanged.
function broadcastBinary(buf: Buffer) {
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(buf, { binary: true });
  }
}

// ---- Single ComfyUI status poller, broadcast on change ----
// Status is sourced from the local status service. The WS message type is
// kept as `launcher-status` for frontend back-compat (it still listens under
// that name). Shape: { running, pid, uptime, versions, gpuMode, ... }.
let lastLauncherStatus: unknown = null;
let lastLauncherStatusJson = '';

// Guard so we only kick the sentry hydration once per ComfyUI-up transition;
// resets the next time we see ComfyUI drop so a restart re-hydrates.
let sentryHydratedOnce = false;

async function pollLauncherStatus() {
  let data: Record<string, unknown>;
  try {
    data = await getLocalComfyUIStatus() as unknown as Record<string, unknown>;
  } catch (err) {
    data = { reachable: false, error: String(err) };
  }
  const json = JSON.stringify(data);
  if (json !== lastLauncherStatusJson) {
    lastLauncherStatus = data;
    lastLauncherStatusJson = json;
    broadcast({ type: 'launcher-status', data });
  }
  // Hydrate gallery sentry from ComfyUI's queue on first reachable status so
  // any prompts running when Studio started (or left pending across a
  // ComfyUI restart) still land in the gallery once they finish.
  const running = (data as { running?: unknown })?.running === true;
  if (running && !sentryHydratedOnce) {
    sentryHydratedOnce = true;
    hydrateFromQueue().catch((err) => {
      logger.warn('gallery sentry: boot hydrate failed', {
        message: err instanceof Error ? err.message : String(err),
      });
    });
  } else if (!running && sentryHydratedOnce) {
    sentryHydratedOnce = false;
  }
}

setInterval(pollLauncherStatus, 5000).unref();
pollLauncherStatus();

// Hook up downloads service so it can broadcast progress to all WS clients.
setDownloadBroadcaster(broadcast);
// Ollama pull progress relayed from chat broadcaster to the Downloads tab bus.
setOllamaPullBus(broadcast);
// Gallery mutations (delete, bulk-delete) broadcast a `gallery` message so
// other tabs update their total + recents without polling.
galleryService.setGalleryBroadcaster(broadcast);
// Chat streaming + Ollama model-pull progress flow through this same broadcaster.
setChatBroadcaster(broadcast);
// Videoboard job tracker + route stubs broadcast WS events through this.
setVideoboardBroadcaster(broadcast);
setVideoboardRouteBroadcaster(broadcast);
// Capability-pack install/uninstall progress (Packs.tsx).
setPackBroadcaster(broadcast);
// ACE-Step music generation / voice-clone TTS / LoRA training progress
// (music page's Create/Tts/Train tabs).
setAceBroadcaster(broadcast);
// AI-Toolkit image-LoRA training progress + live log tail (JobsPanel.tsx).
setAiToolkitBroadcaster(broadcast);

// ---- Queue & gallery broadcasts ----
// Triggered by ComfyUI WS events. Debounced so bursts of messages (e.g. per-node
// 'executed') collapse into one broadcast.
let queueTimer: NodeJS.Timeout | null = null;

function scheduleQueueBroadcast() {
  if (queueTimer) return;
  queueTimer = setTimeout(async () => {
    queueTimer = null;
    try {
      const queue = await getQueue();
      broadcast({ type: 'queue', data: queue });
    } catch { /* ignore */ }
    // Sentry tick: fetch the promptId set and let the sentry detect any
    // watched promptId that's no longer in the queue (i.e. just finished).
    try {
      const ids = await getQueuePromptIds();
      void onQueueStatus(ids);
    } catch { /* ignore — next queue event will retry */ }
  }, 100);
}

// ---- Cached last gpu snapshot — sent to each new WS client on connect so
// the sidebar SchedulerQueueCard has data before the first state-change. ----
let lastGpuSnapshotJson = '';

// ---- Client WS: browser clients join the `clients` set; ComfyUI events are
// forwarded by the shared bridge (wired once in start() below), not per-client.
wss.on('connection', (clientWs) => {
  clients.add(clientWs);

  if (lastLauncherStatus !== null) {
    clientWs.send(JSON.stringify({ type: 'launcher-status', data: lastLauncherStatus }));
  }
  // Hydrate in-progress downloads so a freshly-loaded page sees them instantly.
  const snapshot = getAllDownloads();
  if (snapshot.length > 0) {
    clientWs.send(JSON.stringify({ type: 'downloads-snapshot', data: snapshot }));
  }
  // Hydrate the GPU scheduler snapshot if we have one cached — avoids a
  // blank SchedulerQueueCard until the next state change fires.
  if (lastGpuSnapshotJson) {
    clientWs.send(lastGpuSnapshotJson);
  }

  const cleanup = () => {
    clients.delete(clientWs);
  };

  clientWs.on('close', cleanup);
  clientWs.on('error', cleanup);
});

async function start() {
  const comfyUrl = getComfyUIUrl();
  logger.info(`ComfyUI URL: ${comfyUrl}`);

  // Subscribe the preview-download hook so preview images are fetched
  // asynchronously whenever a sidecar is written by the enrichment layer.
  registerPreviewHook();

  // Forward `model:enriched` bus events to WS clients so the Models page can
  // refresh affected rows without polling.
  registerEnrichmentWsHook();

  // Subscribe the templates repo to model/plugin lifecycle events so the
  // `installed` readiness flag stays in sync with disk state.
  wireTemplateEventHandlers();
  // Subscribe the catalog store to the same model-lifecycle events so
  // pre-populated rows flip from `downloading: true` to installed/error as
  // the download finishes.
  wireCatalogEventHandlers();
  // Subscribe the SQLite-backed model index to the bus so single-file
  // installs/removals stay in sync without a full disk walk.
  wireModelIndexEventHandlers();

  // Hot the folder registry (cached /api/experiment/models) before the
  // catalog migration runs — migration needs disk-truth lookups against the
  // current ComfyUI folder layout.
  refreshRegistry(true).catch((err) => {
    logger.warn('folderRegistry: initial refresh failed', {
      message: err instanceof Error ? err.message : String(err),
    });
  });
  // Version-gated one-shot canonicalize migration. No-op once schema_version
  // matches TARGET_VERSION. Errors don't block boot.
  migrateCatalogIfNeeded().catch((err) => {
    logger.warn('catalog migrate: aborted', {
      message: err instanceof Error ? err.message : String(err),
    });
  });

  // Boot-time hash backfill: walk every model_files row whose sha256 is null
  // and compute it in the background. Sequential per-file, idempotent — no-op
  // when nothing's missing. Runs concurrently with the rest of boot; errors
  // don't block.
  void import('./services/models/enrichment/hashCompute.js').then(
    ({ startHashQueue }) => startHashQueue(),
  ).catch((err) => {
    logger.warn('hash-queue: boot kickoff failed', {
      message: err instanceof Error ? err.message : String(err),
    });
  });

  // Make ComfyUI's output/ directory reachable from input/ via a single
  // symlink — `input/output_load → output`. The MediaLibraryModal's Output
  // source surfaces files under `output_load/...`, so the standard LoadImage
  // / LoadAudio / LoadVideo nodes resolve them without a per-file copy or a
  // template rewrite.
  void import('./services/mediaLibrary.js').then(
    ({ ensureOutputInputSymlink }) => ensureOutputInputSymlink(),
  ).catch((err) => {
    logger.warn('output-input symlink: boot setup failed', {
      message: err instanceof Error ? err.message : String(err),
    });
  });

  // Open the ONE shared ComfyUI upstream WS. All event consumers subscribe
  // here; no per-browser upstream is opened. Subscriptions are mounted ONCE
  // at boot so there are no per-request listener leaks.
  const {
    startComfyJobBridge,
    onRaw,
    onBinary,
    onStatus,
    onExecuted,
    onExecutionComplete,
    getComfyState,
  } = await import('./services/comfyui/jobBridge.js');
  startComfyJobBridge();

  // Single gpu-broadcast helper — used by scheduler state changes AND by
  // bridge status events (so the sidebar sees external comfy queue updates
  // without a Studio-side state change). Snapshot is cached as a serialised
  // string so each new WS connection can hydrate instantly.
  const broadcastGpu = () => {
    const data = { ...scheduler.snapshot(), comfy: getComfyState() };
    lastGpuSnapshotJson = JSON.stringify({ type: 'gpu', data });
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(lastGpuSnapshotJson);
    }
  };

  // Forward every raw ComfyUI message to all connected browser clients.
  onRaw((json) => broadcastRaw(json));
  // Same for binary preview frames (KSampler emits these during sampling
  // when ComfyUI was launched with `--preview-method`). Pass-through to
  // every client; the UI parses the 8-byte header and renders the blob.
  onBinary((buf) => broadcastBinary(buf));

  // Queue broadcast on status messages (queue changes).
  onStatus(() => scheduleQueueBroadcast());

  // Bridge status carries ComfyUI's queue_remaining + execution lifecycle
  // — broadcast a fresh gpu snapshot so external (comfy-direct) activity
  // shows up in the sidebar without polling.
  onStatus(() => broadcastGpu());

  // Gallery + queue on executed (node finished with output).
  onExecuted((promptId, output, nodeId) => {
    void galleryService.onNodeExecuted(promptId, output, nodeId);
    scheduleQueueBroadcast();
  });

  // Gallery reconcile + queue on execution complete.
  onExecutionComplete((promptId) => {
    void galleryService.onExecutionComplete(promptId);
    scheduleQueueBroadcast();
  });

  // Probe boot state: align GPU residency with what was already running.
  const { bootRecovery } = await import('./services/gpu/bootRecovery.js');
  await bootRecovery().catch((err) => {
    logger.warn('bootRecovery: probe failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // ONE state-change listener at boot; broadcast gpu snapshot (incl. comfy
  // mirror state) to all WS clients.
  scheduler.onStateChange(broadcastGpu);
  // Push an initial snapshot so even pre-existing WS clients (kept open
  // through a server restart) see current state.
  broadcastGpu();

  // Sweep leftover files in the uploads tmp dir (orphans from any prior
  // crash mid-upload). Safe because we only delete files older than 1h.
  sweepStaleUploads();

  // Sweep prompt snapshots older than 1 hour every 10 minutes.
  const snapshotSweepTimer = setInterval(
    () => promptSnapshotsRepo.sweepOldSnapshots(60 * 60 * 1000),
    10 * 60 * 1000,
  );
  snapshotSweepTimer.unref();

  // Validate the bundled chat prompts file at boot — every required key
  // must resolve, otherwise the chat path will silently fall back to ''.
  try {
    const { validatePromptsFile } = await import('./services/chat/promptsLoader.js');
    validatePromptsFile();
  } catch (err) {
    logger.warn('promptsLoader: validation failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Boot the MCP client registry so external MCP servers (Context7, etc.)
  // get connected during startup and their tools are available on the very
  // first chat turn. Failures are non-fatal — chat works without them.
  try {
    // One-shot rewrite of legacy `mcp__<UUID>__<tool>` keys in
    // enabledMcpTools to the new slug-based `mcp__<slug>__<tool>` form.
    // Idempotent: only writes when at least one key changes.
    const { migrateEnabledMcpToolKeys } = await import('./services/settings/mcp.js');
    const rewrites = migrateEnabledMcpToolKeys();
    if (rewrites > 0) {
      logger.info(`migrated ${rewrites} enabledMcpTools keys from server UUID to slug form`);
    }

    const { getRegistry } = await import('./services/mcp/client/index.js');
    await getRegistry().boot();
  } catch (err) {
    logger.warn('MCP client registry boot failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  server.listen(PORT, () => {
    logger.info(`ComfyUI Studio server running on port ${PORT}`);
  });

  // Start the ComfyUI reverse proxy on env.COMFYUI_PROXY_PORT so the native
  // frontend remains reachable even when ComfyUI itself is restarting. The
  // helper never throws and returns null when the proxy is disabled.
  try {
    startComfyUIProxy();
  } catch (err) {
    logger.error('failed to start comfyui proxy', { error: String(err) });
  }

  // Populate the SQLite-backed model index before seeding templates so
  // the readiness recompute that follows sees real on-disk state.
  try {
    await ensureModelIndexFresh();
  } catch (err) {
    logger.warn('model index ensureFresh failed', { error: String(err) });
  }
  // No boot-time template cache rebuild needed — all template listing now
  // goes directly to the DB via templates.repo.listPaginated.
}

start().catch((err) => logger.error('server failed to start', { error: String(err) }));
