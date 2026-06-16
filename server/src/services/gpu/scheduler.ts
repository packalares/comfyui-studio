// Cross-tenant GPU scheduler. Concurrency = 1. Priority queue (lower number =
// higher priority, same priority = FIFO by enqueue time). One slot is held from
// the moment a job starts until the caller invokes the release() callback.
//
// Memory-leak hot spots handled here:
//   - Queue: unbounded by design; snapshot() exposes queue length so a stuck
//     queue is visible. INTENTIONAL: no auto-drop because jobs must complete.
//   - Completed-job entries: dropped as soon as their Promise settles.
//   - Per-job AbortController: abort() fires on cancel + on slot release.
//   - State-change listeners: EventEmitter with standard listenerCount semantics.

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { logger } from '../../lib/logger.js';
import { ensureResident, forceSetTenant, getCurrentTenant, unloadOllama } from './residency.js';
import type { GpuTenant, TaskType } from './taskTypes.js';
import { TASK_TYPES } from './taskTypes.js';

// How long the scheduler stays idle on a tenant before unloading it.
// Currently only applies to `ollama` — comfy is already evicted on tenant
// switch via the queue-idle guard in unloadComfy(), and the warm-cache
// benefit isn't symmetric (ollama reload ~30-50s; comfy cold-start much
// heavier, so we keep it warm until something explicitly needs the slot).
const OLLAMA_IDLE_EVICT_MS = 60 * 1000;

// ---- Public types ----

export class CancelledError extends Error {
  readonly jobId: string;
  constructor(jobId: string) {
    super(`GPU scheduler job ${jobId} was cancelled`);
    this.name = 'CancelledError';
    this.jobId = jobId;
  }
}

export interface SubmitInput<T> {
  taskType: TaskType;
  tenant: GpuTenant;
  priority: number;
  run: (release: () => void) => Promise<T>;
  signal?: AbortSignal;
}

export interface ActiveJob {
  jobId: string;
  taskType: string;
  tenant: GpuTenant;
  priority: number;
  startedAt: number;
}

export interface QueueEntry {
  jobId: string;
  taskType: string;
  tenant: GpuTenant;
  priority: number;
  enqueuedAt: number;
}

export interface SchedulerSnapshot {
  residency: GpuTenant;
  active: ActiveJob | null;
  queue: QueueEntry[];
}

// ---- Internal queue entry ----

interface PendingJob {
  jobId: string;
  taskType: string;
  tenant: GpuTenant;
  priority: number;
  enqueuedAt: number;
  run: (release: () => void) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
}

// ---- Scheduler singleton ----

class GpuScheduler {
  private readonly emitter = new EventEmitter();
  private slot: ActiveJob | null = null;
  private readonly queue: PendingJob[] = [];
  // Watchdog timer for the current slot. Force-releases when fired.
  private slotWatchdog: NodeJS.Timeout | null = null;
  // Callback that release()s the active job. Wired in runJob() so
  // forceReleaseActive() can trigger it from outside the runJob closure.
  private slotReleaser: (() => void) | null = null;
  // Idle-evict timer. When the scheduler goes idle on `ollama`, start a
  // timer; if no new job arrives by OLLAMA_IDLE_EVICT_MS, unload Ollama so
  // VRAM is recovered. Reset on every drain / submit.
  private ollamaIdleEvictTimer: NodeJS.Timeout | null = null;

  onStateChange(listener: () => void): void {
    this.emitter.on('state', listener);
  }

  offStateChange(listener: () => void): void {
    this.emitter.off('state', listener);
  }

  private emit(): void {
    this.emitter.emit('state');
  }

  snapshot(): SchedulerSnapshot {
    return {
      residency: getCurrentTenant(),
      active: this.slot ? { ...this.slot } : null,
      queue: this.queue.map(j => ({
        jobId: j.jobId,
        taskType: j.taskType,
        tenant: j.tenant,
        priority: j.priority,
        enqueuedAt: j.enqueuedAt,
      })),
    };
  }

  /**
   * Submit a job to the scheduler. Returns a Promise that resolves/rejects with
   * the return value of run(). The slot is held until release() is called.
   */
  submit<T>(input: SubmitInput<T>): Promise<T> {
    const jobId = randomUUID();
    const enqueuedAt = Date.now();

    // Early abort check.
    if (input.signal?.aborted) {
      return Promise.reject(new CancelledError(jobId));
    }

    return new Promise<T>((resolve, reject) => {
      const pending: PendingJob = {
        jobId,
        taskType: input.taskType,
        tenant: input.tenant,
        priority: input.priority,
        enqueuedAt,
        run: input.run as (release: () => void) => Promise<unknown>,
        resolve: resolve as (v: unknown) => void,
        reject,
        signal: input.signal,
      };

      if (input.signal) {
        const abortListener = () => {
          this.cancel(jobId);
        };
        pending.abortListener = abortListener;
        input.signal.addEventListener('abort', abortListener, { once: true });
      }

      // Insert into the sorted queue: lower priority number first, FIFO on ties.
      let insertAt = this.queue.length;
      for (let i = 0; i < this.queue.length; i += 1) {
        const q = this.queue[i];
        // Insert before the first item with strictly lower priority number,
        // or with same priority but strictly later enqueue time.
        // FIFO within same priority: items with the same timestamp go AFTER
        // existing ones (append semantics), so we only pre-empt when strictly less.
        if (input.priority < q.priority) { insertAt = i; break; }
      }
      this.queue.splice(insertAt, 0, pending);

      this.emit();
      this.drain();
    });
  }

  /**
   * Force-release the currently active slot. Used as an escape hatch when a
   * run() handler hangs (e.g. an upstream that never closes, a missed
   * terminal event). Returns true if a slot was released, false if idle.
   * The underlying run() Promise is NOT cancelled — it continues to its own
   * fate — but the scheduler will accept and drain the next queued job.
   */
  forceReleaseActive(): boolean {
    if (!this.slotReleaser) return false;
    logger.warn('[scheduler] forceReleaseActive — releasing held slot', {
      jobId: this.slot?.jobId,
      taskType: this.slot?.taskType,
    });
    const r = this.slotReleaser;
    this.slotReleaser = null;
    r();
    return true;
  }

  /**
   * Cancel a queued (not running) job. Returns 'cancelled' on success,
   * 'not_found' when no such id exists, 'running' when the job is the active slot.
   */
  cancel(jobId: string): 'cancelled' | 'not_found' | 'running' {
    if (this.slot?.jobId === jobId) return 'running';

    const idx = this.queue.findIndex(j => j.jobId === jobId);
    if (idx === -1) return 'not_found';

    const [job] = this.queue.splice(idx, 1);
    if (job.signal && job.abortListener) {
      job.signal.removeEventListener('abort', job.abortListener);
    }
    job.reject(new CancelledError(jobId));
    this.emit();
    return 'cancelled';
  }

  /**
   * Swap GPU residency to a different tenant while keeping the current slot.
   * Used by a running job (e.g. chat) to hand VRAM to a tool call without
   * yielding the slot. The queue does NOT advance.
   */
  async switchTenant(tenant: GpuTenant): Promise<void> {
    if (getCurrentTenant() === tenant) return;
    await ensureResident(tenant);
    this.emit();
  }

  private cancelIdleEvict(): void {
    if (this.ollamaIdleEvictTimer) {
      clearTimeout(this.ollamaIdleEvictTimer);
      this.ollamaIdleEvictTimer = null;
    }
  }

  // Arm the idle-evict timer when (and only when) the scheduler is fully
  // idle AND the current tenant is `ollama`. Re-armed by drain() / release().
  private armOllamaIdleEvictIfNeeded(): void {
    this.cancelIdleEvict();
    if (this.slot !== null) return;
    if (this.queue.length > 0) return;
    if (getCurrentTenant() !== 'ollama') return;
    this.ollamaIdleEvictTimer = setTimeout(() => {
      this.ollamaIdleEvictTimer = null;
      // Re-check just-in-time: a job could have arrived between the timer
      // firing and the macrotask running.
      if (this.slot !== null) return;
      if (this.queue.length > 0) return;
      if (getCurrentTenant() !== 'ollama') return;
      logger.info('[scheduler] ollama idle for OLLAMA_IDLE_EVICT_MS, unloading', {
        idleMs: OLLAMA_IDLE_EVICT_MS,
      });
      void (async () => {
        try {
          await unloadOllama();
          forceSetTenant('none');
          this.emit();
        } catch (err) {
          logger.warn('[scheduler] idle-evict unloadOllama failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
    }, OLLAMA_IDLE_EVICT_MS);
    this.ollamaIdleEvictTimer.unref?.();
  }

  private drain(): void {
    // A drain step either pops a job (cancels idle-evict) or stays idle
    // (re-arms it). Either way, recompute.
    this.cancelIdleEvict();
    if (this.slot !== null) return;
    if (this.queue.length === 0) {
      this.armOllamaIdleEvictIfNeeded();
      return;
    }

    const job = this.queue.shift()!;

    // Clean up signal listener now that we're starting the job.
    if (job.signal && job.abortListener) {
      job.signal.removeEventListener('abort', job.abortListener);
      job.abortListener = undefined;
    }

    this.slot = {
      jobId: job.jobId,
      taskType: job.taskType,
      tenant: job.tenant,
      priority: job.priority,
      startedAt: Date.now(),
    };
    this.emit();

    void this.runJob(job);
  }

  private async runJob(job: PendingJob): Promise<void> {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (this.slotWatchdog) {
        clearTimeout(this.slotWatchdog);
        this.slotWatchdog = null;
      }
      this.slotReleaser = null;
      this.slot = null;
      this.emit();
      this.drain();
    };
    this.slotReleaser = release;

    // Per-task watchdog: if the run() handler stays held past the cap (e.g.
    // a hanging upstream that doesn't honour AbortSignal), force-release so
    // the queue keeps moving. The run() Promise is left to its own fate.
    const def = TASK_TYPES[job.taskType as TaskType];
    const maxMs = def?.maxRuntimeMs;
    if (typeof maxMs === 'number' && maxMs > 0) {
      this.slotWatchdog = setTimeout(() => {
        if (released) return;
        logger.warn('[scheduler] watchdog fired — slot held past maxRuntimeMs', {
          jobId: job.jobId,
          taskType: job.taskType,
          maxMs,
        });
        release();
      }, maxMs);
      // Unref so a long-running studio doesn't keep the event loop alive on shutdown.
      this.slotWatchdog.unref?.();
    }

    try {
      // Ensure the GPU is resident for this tenant before calling run().
      await ensureResident(job.tenant);
      const result = await job.run(release);
      job.resolve(result);
    } catch (err) {
      job.reject(err instanceof Error ? err : new Error(String(err)));
    } finally {
      // Slot leak protection: always release if run() threw or forgot to call release().
      if (!released) {
        logger.warn('[scheduler] run() returned without calling release(); auto-releasing slot', {
          jobId: job.jobId,
        });
        release();
      }
    }
  }
}

// Module-level singleton.
export const scheduler = new GpuScheduler();

/**
 * Convenience wrapper: derives tenant + priority from TASK_TYPES and calls
 * scheduler.submit(). Callers that need custom priority can call scheduler.submit() directly.
 */
export function submitGpuJob<T>(
  taskType: TaskType,
  run: (release: () => void) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const def = TASK_TYPES[taskType];
  return scheduler.submit<T>({
    taskType,
    tenant: def.tenant,
    priority: def.priority,
    run,
    signal,
  });
}
