/**
 * Server-owned persistent WebSocket subscription to ComfyUI's `/ws` endpoint.
 *
 * Design:
 *   - ONE singleton WS for the life of the server process, auto-reconnects
 *     with 5 s backoff. All consumers subscribe here; nobody opens a second
 *     upstream connection.
 *
 * Subscription API (mount ONCE at boot, never per-request):
 *   bridge.onRaw(json => ...)            — raw ComfyUI JSON string → forward to browsers
 *   bridge.onStatus(() => ...)           — fired on every `status` message
 *   bridge.onExecuted((id, out) => ...)  — fired on `executed` with prompt_id + output
 *   bridge.onExecutionComplete(id => ...)— fired on execution_success / execution_complete
 *
 * Tracked-prompt API (videoboard):
 *   trackComfyPrompt(promptId, opts)     — Promise<void>, resolves/rejects on terminal events
 *
 * Jobs SSE API (internal):
 *   fanToEventBus(promptId, msg)         — fires for ALL prompts, not only tracked ones
 */
import { randomUUID } from 'node:crypto';
import EventEmitter from 'node:events';
import WebSocket from 'ws';
import { logger } from '../../lib/logger.js';
import { getComfyUIUrl, getQueuePromptIds, getHistoryForPrompt } from '../comfyui/api.js';
import * as eventBus from '../jobs/eventBus.js';

// ---------------------------------------------------------------------------
// Internal event emitter — backs the public subscription API.
// Max-listeners raised to 32 per event so boot-time wiring + tests never
// trigger Node's "possible leak" warning.
// ---------------------------------------------------------------------------

// Typed event map keeps subscriber signatures correct without `any`.
interface BridgeEvents {
  raw: [json: string];
  status: [];
  executed: [promptId: string, output: Record<string, unknown>];
  executionComplete: [promptId: string];
}

class BridgeEmitter extends EventEmitter {
  // Override to carry the typed event map.
  override emit<K extends keyof BridgeEvents>(
    event: K,
    ...args: BridgeEvents[K]
  ): boolean {
    return super.emit(event, ...args);
  }
  override on<K extends keyof BridgeEvents>(
    event: K,
    listener: (...args: BridgeEvents[K]) => void,
  ): this {
    return super.on(event, listener as (...a: unknown[]) => void);
  }
  override off<K extends keyof BridgeEvents>(
    event: K,
    listener: (...args: BridgeEvents[K]) => void,
  ): this {
    return super.off(event, listener as (...a: unknown[]) => void);
  }
}

const emitter = new BridgeEmitter();
// 0 = unlimited; suppresses Node's "possible leak" warning even in tests that
// stress-subscribe 1000 times. Memory-leak protection is provided by tests
// (see comfyJobBridge.test.ts) that assert the count returns to baseline, not
// by EventEmitter's built-in cap (which would only warn, not throw).
emitter.setMaxListeners(0);

// ---------------------------------------------------------------------------
// Public subscription API
// Each on* returns an unsubscribe function so callers can clean up.
// ALL should be mounted ONCE at boot, never inside a per-request handler.
// ---------------------------------------------------------------------------

/** Subscribe to every raw ComfyUI JSON string as-received. */
export function onRaw(handler: (json: string) => void): () => void {
  emitter.on('raw', handler);
  return () => emitter.off('raw', handler);
}

/** Subscribe to ComfyUI `status` messages (fires on queue changes). */
export function onStatus(handler: () => void): () => void {
  emitter.on('status', handler);
  return () => emitter.off('status', handler);
}

/** Subscribe to ComfyUI `executed` events (node finished, has output). */
export function onExecuted(
  handler: (promptId: string, output: Record<string, unknown>) => void,
): () => void {
  emitter.on('executed', handler);
  return () => emitter.off('executed', handler);
}

/** Subscribe to ComfyUI execution_success / execution_complete events. */
export function onExecutionComplete(handler: (promptId: string) => void): () => void {
  emitter.on('executionComplete', handler);
  return () => emitter.off('executionComplete', handler);
}

// ---------------------------------------------------------------------------
// Tracked-prompt registry
// ---------------------------------------------------------------------------

interface Resolver {
  resolve: () => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
  abortListener?: () => void;
  signal?: AbortSignal;
  startedAt: number;
}

const tracked = new Map<string, Resolver>();

function clearResolver(promptId: string): Resolver | undefined {
  const r = tracked.get(promptId);
  if (!r) return undefined;
  clearTimeout(r.timeout);
  if (r.signal && r.abortListener) {
    r.signal.removeEventListener('abort', r.abortListener);
  }
  tracked.delete(promptId);
  return r;
}

function resolveTracked(promptId: string, why: string): void {
  const r = clearResolver(promptId);
  if (!r) return;
  const elapsedMs = Date.now() - r.startedAt;
  logger.info?.(
    `[comfyJobBridge] prompt ${promptId} ${why} after ${elapsedMs}ms`,
  );
  r.resolve();
}

function rejectTracked(promptId: string, err: Error): void {
  const r = clearResolver(promptId);
  if (!r) return;
  const elapsedMs = Date.now() - r.startedAt;
  logger.warn?.(
    `[comfyJobBridge] prompt ${promptId} rejected after ${elapsedMs}ms: ${err.message}`,
  );
  r.reject(err);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface TrackOptions {
  /** Hard upper bound — rejects with TimeoutError if ComfyUI never emits a
   *  terminal event for this prompt within this window. */
  timeoutMs: number;
  /** Optional caller abort signal (e.g. user removed audio mid-run). */
  signal?: AbortSignal;
}

export class ComfyJobCancelledError extends Error {
  constructor(promptId: string, source: 'comfyui' | 'caller' | 'timeout') {
    super(`prompt ${promptId} cancelled (${source})`);
    this.name = 'ComfyJobCancelledError';
  }
}

export class ComfyJobExecutionError extends Error {
  constructor(promptId: string, details: string) {
    super(`prompt ${promptId} failed: ${details}`);
    this.name = 'ComfyJobExecutionError';
  }
}

/**
 * Track a ComfyUI prompt by its prompt_id and return a Promise that settles
 * when the run terminates (one way or another).
 *
 * Resolution sources, in priority order:
 *   - execution_success / execution_complete WS event  → resolve()
 *   - execution_cancelled / execution_interrupted WS event → reject(Cancelled)
 *   - execution_error WS event                          → reject(Execution)
 *   - opts.signal.aborted                                → reject(Cancelled 'caller')
 *   - opts.timeoutMs deadline                            → reject(Cancelled 'timeout')
 *
 * Callers should NOT also start a /history poll — fetch /history exactly once
 * after this Promise resolves to read the output payload.
 */
export function trackComfyPrompt(
  promptId: string,
  opts: TrackOptions,
): Promise<void> {
  if (!promptId) {
    return Promise.reject(new Error('trackComfyPrompt: empty promptId'));
  }
  if (tracked.has(promptId)) {
    // Should never happen — ComfyUI emits unique prompt_ids — but if it does
    // (e.g. caller bug), don't silently replace the previous resolver.
    return Promise.reject(new Error(`prompt ${promptId} already tracked`));
  }
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      // Caller-side timeout. The run may still be going on the GPU; we just
      // give up listening so the caller's outer Promise doesn't hang.
      rejectTracked(promptId, new ComfyJobCancelledError(promptId, 'timeout'));
    }, opts.timeoutMs);

    let abortListener: (() => void) | undefined;
    if (opts.signal) {
      if (opts.signal.aborted) {
        clearTimeout(timeout);
        reject(new ComfyJobCancelledError(promptId, 'caller'));
        return;
      }
      abortListener = () => {
        rejectTracked(promptId, new ComfyJobCancelledError(promptId, 'caller'));
      };
      opts.signal.addEventListener('abort', abortListener);
    }

    tracked.set(promptId, {
      resolve,
      reject,
      timeout,
      signal: opts.signal,
      abortListener,
      startedAt: Date.now(),
    });
    logger.info?.(`[comfyJobBridge] tracking prompt ${promptId} (timeout ${opts.timeoutMs}ms)`);
    scheduleQueuePoll();
  });
}

// ---------------------------------------------------------------------------
// WS lifecycle
// ---------------------------------------------------------------------------

let ws: WebSocket | null = null;
let retryTimer: NodeJS.Timeout | null = null;
let queuePollTimer: NodeJS.Timeout | null = null;
let started = false;
// Stable clientId for the lifetime of this server process. ComfyUI routes
// per-prompt events (`executed`, `execution_success`, …) ONLY to the client
// that submitted the prompt. Callers that want those events MUST pass this
// clientId via `submitPrompt({..., clientId: getBridgeClientId()})`.
const BRIDGE_CLIENT_ID = `studio-jobs-${randomUUID()}`;

export function getBridgeClientId(): string {
  return BRIDGE_CLIENT_ID;
}

const RECONNECT_BACKOFF_MS = 5000;

// Temporary diagnostic: log the type of every incoming WS message for tracked
// prompts so we can see what shape ComfyUI is actually broadcasting. Remove
// once the event-name mismatch is identified and fixed.
const DEBUG_LOG_EVENTS = false;

interface ComfyExecutionEvent {
  type?: string;
  data?: {
    prompt_id?: string;
    exception_message?: string;
    exception_type?: string;
    traceback?: unknown;
    // progress event fields
    node?: string;
    value?: number;
    max?: number;
  };
}

function handleComfyMessage(raw: string): void {
  let msg: ComfyExecutionEvent;
  try {
    msg = JSON.parse(raw) as ComfyExecutionEvent;
  } catch {
    return; // ComfyUI also sends binary frames for previews; ignore non-JSON.
  }

  // Always forward raw JSON to all raw subscribers (browser passthrough).
  emitter.emit('raw', raw);

  // Temporary diagnostic: log EVERY non-progress event type ComfyUI broadcasts,
  // regardless of whether it's tied to a tracked prompt. Lets us see if the
  // bridge's WS is receiving `executed` / `execution_*` events at all on
  // this ComfyUI build, or if ComfyUI uses entirely different event names.
  if (DEBUG_LOG_EVENTS && msg.type !== 'progress' && msg.type !== 'progress_state') {
    logger.info?.(
      `[comfyJobBridge] DEBUG type=${msg.type ?? '<no-type>'} data=${JSON.stringify(msg.data ?? {}).slice(0, 300)}`,
    );
  }

  // `status` messages carry queue state but may omit prompt_id; fire before
  // the prompt_id guard so the queue-broadcast subscriber always fires.
  if (msg.type === 'status') {
    emitter.emit('status');
  }

  const promptId = msg.data?.prompt_id;
  if (typeof promptId !== 'string') return;

  // Fire typed subscription events for prompt-scoped message types.
  if (msg.type === 'executed') {
    const output = (msg.data as Record<string, unknown> | undefined)?.['output'];
    emitter.emit(
      'executed',
      promptId,
      (output !== null && typeof output === 'object' ? output : {}) as Record<string, unknown>,
    );
  } else if (msg.type === 'execution_success' || msg.type === 'execution_complete') {
    emitter.emit('executionComplete', promptId);
  }

  // Fan relevant events to the per-job event bus for SSE subscribers.
  // This runs for ALL prompts, not just tracked ones, so external callers
  // submitting via /api/generate also see live events.
  fanToEventBus(promptId, msg);

  if (!tracked.has(promptId)) return;

  switch (msg.type) {
    // execution/server.py:795 — emitted after all nodes finish successfully.
    // broadcast=false so only the submitting clientId receives it.
    case 'execution_success':
    // execution_complete: kept for forward-compat; not emitted by this ComfyUI
    // build but harmless to handle if a future version adds it.
    case 'execution_complete':
      resolveTracked(promptId, msg.type);
      break;
    // execution/server.py:682 — InterruptProcessingException path (user pressed
    // "Interrupt" in ComfyUI canvas); broadcast=true so all clients see it.
    case 'execution_interrupted':
    // execution_cancelled: not emitted by this ComfyUI build; kept for compat.
    case 'execution_cancelled':
      rejectTracked(promptId, new ComfyJobCancelledError(promptId, 'comfyui'));
      break;
    // execution/server.py:695 — any other execution exception; broadcast=false.
    case 'execution_error': {
      const exc = msg.data?.exception_message ?? msg.data?.exception_type ?? 'unknown';
      rejectTracked(promptId, new ComfyJobExecutionError(promptId, String(exc)));
      break;
    }
    // execution_start, execution_cached, executing, executed, progress — all
    // non-terminal; the queue-presence poller (see pollQueueForVanishedPrompts)
    // handles the clear-queue case where NO terminal event fires.
    // `executing` with node=null is only sent on WS reconnect (server.py:276),
    // not as a completion signal — do not treat it as terminal.
    default:
      break;
  }
}

function fanToEventBus(promptId: string, msg: ComfyExecutionEvent): void {
  switch (msg.type) {
    case 'execution_success':
    case 'execution_complete':
      eventBus.emit(promptId, { type: 'done', data: { status: 'success' } });
      break;
    case 'execution_interrupted':
    case 'execution_cancelled':
      eventBus.emit(promptId, {
        type: 'error',
        data: { code: 'cancelled', message: `prompt ${promptId} was cancelled` },
      });
      break;
    case 'execution_error': {
      const exc = msg.data?.exception_message ?? msg.data?.exception_type ?? 'unknown';
      eventBus.emit(promptId, {
        type: 'error',
        data: { code: 'execution_error', message: String(exc) },
      });
      break;
    }
    case 'progress': {
      const node = msg.data?.node ?? '';
      const step = typeof msg.data?.value === 'number' ? msg.data.value : 0;
      const total = typeof msg.data?.max === 'number' ? msg.data.max : 0;
      eventBus.emit(promptId, { type: 'progress', data: { node, step, total } });
      break;
    }
    case 'executing':
      // `executing` with a node id means a node started; emit a status update.
      eventBus.emit(promptId, { type: 'status', data: { status: 'running' } });
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Queue-presence backstop
// ---------------------------------------------------------------------------
// ComfyUI only emits `execution_interrupted` for prompts that ACTUALLY STARTED.
// A still-pending prompt that gets clear-queued never fires any WS terminal
// event. Without this poller the bridge would wait the full timeout (up to
// 30 min) before rejecting. Every 10 s, when there are tracked prompts, we
// compare the tracked set against ComfyUI's live queue + history. Any prompt
// absent from both (never ran, was clear-queued) is rejected immediately.

const QUEUE_POLL_INTERVAL_MS = 10_000;

async function pollQueueForVanishedPrompts(): Promise<void> {
  if (tracked.size === 0) return;
  let queueIds: Set<string>;
  try {
    queueIds = await getQueuePromptIds();
  } catch {
    return; // ComfyUI unreachable — let the existing timeout handle it
  }
  for (const promptId of Array.from(tracked.keys())) {
    if (queueIds.has(promptId)) continue; // still in queue, normal
    // Not in queue. Check history — if it ran and ComfyUI already emitted
    // the terminal WS event, the tracker was cleared and we'd never reach here.
    // Reaching here with history-present means the WS event was MISSED (e.g.
    // socket reconnect mid-run, server restart between submit and notify).
    // Resolve the tracker so the caller's awaited Promise unblocks; the caller
    // re-fetches /history for the output payload and surfaces error results
    // via downstream parse failures, so resolving unconditionally is safe.
    try {
      const hist = await getHistoryForPrompt(promptId);
      if (hist !== null) {
        resolveTracked(promptId, 'queue-poll: found in history (missed WS event)');
        continue;
      }
    } catch {
      continue; // history fetch failed — don't reject speculatively
    }
    // Not in queue and not in history: was clear-queued before execution started.
    logger.info?.(
      `[comfyJobBridge] prompt ${promptId} vanished from queue without running — rejecting`,
    );
    rejectTracked(promptId, new ComfyJobCancelledError(promptId, 'comfyui'));
  }
}

function scheduleQueuePoll(): void {
  if (!started || queuePollTimer) return;
  queuePollTimer = setTimeout(() => {
    queuePollTimer = null;
    pollQueueForVanishedPrompts().catch(() => { /* never throws */ }).finally(() => {
      if (started && tracked.size > 0) scheduleQueuePoll();
    });
  }, QUEUE_POLL_INTERVAL_MS);
}

function openWs(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  const comfyUrl = getComfyUIUrl().replace(/^http/, 'ws');
  // Same clientId every time we connect, for the life of the server process.
  // submitPrompt callers attach this id so ComfyUI's executor sends per-prompt
  // events back to this WS rather than dropping them.
  const url = `${comfyUrl}/ws?clientId=${BRIDGE_CLIENT_ID}`;
  try {
    const sock = new WebSocket(url);
    ws = sock;
    sock.on('open', () => {
      logger.info?.(`[comfyJobBridge] connected ${url}`);
    });
    sock.on('message', (data) => {
      handleComfyMessage(data.toString());
    });
    sock.on('close', () => {
      if (ws === sock) ws = null;
      logger.warn?.('[comfyJobBridge] disconnected; reconnecting in 5s');
      scheduleReconnect();
    });
    sock.on('error', (err) => {
      // Per-event log only; the close handler does the reconnect work.
      logger.warn?.(`[comfyJobBridge] socket error: ${(err as Error).message}`);
    });
  } catch (err) {
    logger.warn?.(`[comfyJobBridge] failed to open WS: ${(err as Error).message}`);
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (!started) return;
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    openWs();
  }, RECONNECT_BACKOFF_MS);
}

/**
 * Boot the bridge. Idempotent — calling twice is a no-op.
 * Wired into the server entrypoint so the WS is up before any /storyboard/
 * generate request can submit a prompt.
 */
export function startComfyJobBridge(): void {
  if (started) return;
  started = true;
  openWs();
}

/**
 * Shut down the bridge (test cleanup / graceful exit). Resolves all pending
 * trackers with a cancellation so awaiting callers don't hang.
 */
export function stopComfyJobBridge(): void {
  started = false;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (queuePollTimer) {
    clearTimeout(queuePollTimer);
    queuePollTimer = null;
  }
  if (ws) {
    try { ws.close(); } catch { /* ignore */ }
    ws = null;
  }
  for (const promptId of Array.from(tracked.keys())) {
    rejectTracked(promptId, new ComfyJobCancelledError(promptId, 'caller'));
  }
}

// ---------------------------------------------------------------------------
// Test helpers (underscore-prefixed; not for production callers)
// ---------------------------------------------------------------------------

/** Inject a raw JSON string directly into handleComfyMessage without a real WS. */
export function _simulateMessageForTests(raw: string): void {
  handleComfyMessage(raw);
}

/** Current listener count for a given bridge event (for leak assertions). */
export function _listenerCountForTests(event: 'raw' | 'status' | 'executed' | 'executionComplete'): number {
  return emitter.listenerCount(event);
}

/** Remove all listeners from the emitter (test teardown). */
export function _removeAllListenersForTests(): void {
  emitter.removeAllListeners();
}
