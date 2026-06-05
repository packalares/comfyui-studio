// Per-promptId event bus for ComfyUI generation progress and terminal events.
// External SSE subscribers receive live fan-out; replay covers reconnects.

export interface JobEvent {
  type: 'status' | 'progress' | 'done' | 'error';
  data: unknown;
  ts: number;
  seq: number; // monotonic per-promptId, enables Last-Event-ID resume
}

type Handler = (event: JobEvent) => void;

interface PromptEntry {
  events: JobEvent[];            // ring buffer capped at MAX_EVENTS_PER_PROMPT
  seq: number;                   // next sequence number
  handlers: Set<Handler>;
  terminalAt: number | null;     // epoch ms when a terminal event (done/error) was emitted
}

// Max events buffered per promptId — limits replay cost and memory per prompt.
const MAX_EVENTS_PER_PROMPT = 100;
// Max distinct promptId entries — caps total memory under adversarial load.
const MAX_PROMPT_ENTRIES = 500;
// Purge a terminal entry once all listeners are gone AND this window has passed.
const TERMINAL_TTL_MS = 5 * 60 * 1000;
// Sweep interval for purging stale terminal entries.
const SWEEP_INTERVAL_MS = 60 * 1000;

// Insertion-order map so we can evict the oldest under LRU pressure.
const entries = new Map<string, PromptEntry>();

function getOrCreate(promptId: string): PromptEntry {
  let entry = entries.get(promptId);
  if (entry) {
    // Refresh insertion order for LRU eviction: delete then re-insert.
    entries.delete(promptId);
    entries.set(promptId, entry);
    return entry;
  }
  // LRU eviction: drop oldest entry when at capacity.
  if (entries.size >= MAX_PROMPT_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
  entry = { events: [], seq: 0, handlers: new Set(), terminalAt: null };
  entries.set(promptId, entry);
  return entry;
}

export function emit(
  promptId: string,
  partial: Omit<JobEvent, 'ts' | 'seq'>,
): void {
  const entry = getOrCreate(promptId);
  const event: JobEvent = { ...partial, ts: Date.now(), seq: entry.seq++ };

  // Ring buffer: drop oldest when over cap.
  entry.events.push(event);
  if (entry.events.length > MAX_EVENTS_PER_PROMPT) entry.events.shift();

  if (event.type === 'done' || event.type === 'error') {
    entry.terminalAt = event.ts;
  }

  for (const h of entry.handlers) {
    try { h(event); } catch { /* handler errors must not kill the bus */ }
  }
}

/** Subscribe to a promptId. Returns an unsubscribe function. */
export function subscribe(promptId: string, handler: Handler): () => void {
  const entry = getOrCreate(promptId);
  entry.handlers.add(handler);
  return () => {
    entry.handlers.delete(handler);
    // Eager purge: if terminal and no more listeners, remove immediately.
    maybePurge(promptId, entry);
  };
}

/** Return all events emitted after `afterSeq` (exclusive) for replay. */
export function replay(promptId: string, afterSeq: number): JobEvent[] {
  const entry = entries.get(promptId);
  if (!entry) return [];
  return entry.events.filter((e) => e.seq > afterSeq);
}

/** Number of active subscribers for a promptId (for tests and leak guards). */
export function listenerCount(promptId: string): number {
  return entries.get(promptId)?.handlers.size ?? 0;
}

function maybePurge(promptId: string, entry: PromptEntry): void {
  if (
    entry.terminalAt !== null &&
    entry.handlers.size === 0 &&
    Date.now() - entry.terminalAt >= TERMINAL_TTL_MS
  ) {
    entries.delete(promptId);
  }
}

// Periodic sweep: purge entries where terminal + 0 listeners + TTL elapsed.
const sweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of entries) {
    if (
      entry.terminalAt !== null &&
      entry.handlers.size === 0 &&
      now - entry.terminalAt >= TERMINAL_TTL_MS
    ) {
      entries.delete(id);
    }
  }
}, SWEEP_INTERVAL_MS);
// Don't prevent graceful shutdown.
if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

/** Exposed for tests that need to trigger an immediate sweep. */
export function _sweepForTests(): void {
  const now = Date.now();
  for (const [id, entry] of entries) {
    if (
      entry.terminalAt !== null &&
      entry.handlers.size === 0 &&
      now - entry.terminalAt >= TERMINAL_TTL_MS
    ) {
      entries.delete(id);
    }
  }
}

/** Clear all state — only for tests. */
export function _resetForTests(): void {
  entries.clear();
}
