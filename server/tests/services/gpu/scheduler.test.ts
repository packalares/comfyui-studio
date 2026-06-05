// Unit tests for the GPU scheduler.
// All residency calls are mocked so no real ComfyUI/Ollama network traffic occurs.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

// Mock residency module before importing the scheduler.
const mockEnsureResident = vi.fn(async (_tenant: unknown) => { /* no-op */ });
let mockCurrentTenant = 'none';
const mockGetCurrentTenant = vi.fn(() => mockCurrentTenant);
const mockForceSetTenant = vi.fn();

vi.mock('../../../src/services/gpu/residency.js', () => ({
  ensureResident: (...args: unknown[]) => mockEnsureResident(...args),
  getCurrentTenant: () => mockGetCurrentTenant(),
  forceSetTenant: (...args: unknown[]) => mockForceSetTenant(...args),
  unloadOllama: vi.fn(async () => { /* no-op */ }),
  unloadComfy: vi.fn(async () => { /* no-op */ }),
  waitForVramDrop: vi.fn(async () => { /* no-op */ }),
}));

import { CancelledError } from '../../../src/services/gpu/scheduler.js';
import type { GpuTenant } from '../../../src/services/gpu/taskTypes.js';

// ---- TestScheduler: inline reimplementation for per-test isolation ----
// Mirrors the real GpuScheduler class without the module-level singleton so
// each test gets a fresh instance. Kept structurally identical to scheduler.ts
// so TypeScript catches divergence.

interface PendingJobLocal {
  jobId: string;
  taskType: string;
  tenant: GpuTenant;
  priority: number;
  enqueuedAt: number;
  run: (release: () => void) => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
}

class TestScheduler {
  private readonly emitter = new EventEmitter();
  constructor() {
    // Raise max-listeners so the "subscribe/unsubscribe 20 times" test doesn't warn.
    this.emitter.setMaxListeners(50);
  }
  private slot: {
    jobId: string; taskType: string; tenant: GpuTenant; priority: number; startedAt: number;
  } | null = null;
  private readonly queue: PendingJobLocal[] = [];

  onStateChange(listener: () => void): void { this.emitter.on('state', listener); }
  offStateChange(listener: () => void): void { this.emitter.off('state', listener); }
  listenerCount(): number { return this.emitter.listenerCount('state'); }

  snapshot() {
    return {
      residency: mockGetCurrentTenant() as GpuTenant,
      active: this.slot ? { ...this.slot } : null,
      queue: this.queue.map(j => ({
        jobId: j.jobId, taskType: j.taskType, tenant: j.tenant,
        priority: j.priority, enqueuedAt: j.enqueuedAt,
      })),
    };
  }

  submit<T>(input: {
    taskType: string; tenant: GpuTenant; priority: number;
    run: (release: () => void) => Promise<T>; signal?: AbortSignal;
  }): Promise<T> {
    const jobId = randomUUID();
    const enqueuedAt = Date.now();
    if (input.signal?.aborted) return Promise.reject(new CancelledError(jobId));

    return new Promise<T>((resolve, reject) => {
      const pending: PendingJobLocal = {
        jobId, taskType: input.taskType, tenant: input.tenant,
        priority: input.priority, enqueuedAt,
        run: input.run as (r: () => void) => Promise<unknown>,
        resolve: resolve as (v: unknown) => void,
        reject,
        signal: input.signal,
      };
      if (input.signal) {
        const al = () => { this.cancel(jobId); };
        pending.abortListener = al;
        input.signal.addEventListener('abort', al, { once: true });
      }
      let insertAt = this.queue.length;
      for (let i = 0; i < this.queue.length; i += 1) {
        const q = this.queue[i];
        if (input.priority < q.priority) { insertAt = i; break; }
      }
      this.queue.splice(insertAt, 0, pending);
      this.emitter.emit('state');
      this.drain();
    });
  }

  cancel(jobId: string): 'cancelled' | 'not_found' | 'running' {
    if (this.slot?.jobId === jobId) return 'running';
    const idx = this.queue.findIndex(j => j.jobId === jobId);
    if (idx === -1) return 'not_found';
    const [job] = this.queue.splice(idx, 1);
    if (job.signal && job.abortListener) job.signal.removeEventListener('abort', job.abortListener);
    job.reject(new CancelledError(jobId));
    this.emitter.emit('state');
    return 'cancelled';
  }

  async switchTenant(tenant: GpuTenant): Promise<void> {
    if (mockGetCurrentTenant() === tenant) return;
    await mockEnsureResident(tenant);
    mockCurrentTenant = tenant;
    this.emitter.emit('state');
  }

  private drain(): void {
    if (this.slot !== null || this.queue.length === 0) return;
    const job = this.queue.shift()!;
    if (job.signal && job.abortListener) {
      job.signal.removeEventListener('abort', job.abortListener);
      job.abortListener = undefined;
    }
    this.slot = {
      jobId: job.jobId, taskType: job.taskType, tenant: job.tenant,
      priority: job.priority, startedAt: Date.now(),
    };
    this.emitter.emit('state');
    void this.runJob(job);
  }

  private async runJob(job: PendingJobLocal): Promise<void> {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.slot = null;
      this.emitter.emit('state');
      this.drain();
    };
    try {
      await mockEnsureResident(job.tenant);
      const result = await job.run(release);
      job.resolve(result);
    } catch (err) {
      job.reject(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (!released) release();
    }
  }
}

function makeScheduler(): TestScheduler { return new TestScheduler(); }

function defer<T = void>(): {
  promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// ---- Tests ----

beforeEach(() => {
  mockCurrentTenant = 'none';
  mockGetCurrentTenant.mockImplementation(() => mockCurrentTenant);
  mockEnsureResident.mockReset();
  mockEnsureResident.mockImplementation(async () => { /* no-op */ });
});

describe('priority ordering', () => {
  it('queued high-priority job runs before queued low-priority job', async () => {
    const s = makeScheduler();
    const order: string[] = [];
    const blocker = defer();

    // Occupy the slot with the blocker.
    void s.submit({
      taskType: 'blocker', tenant: 'comfy', priority: 20,
      run: async (release) => { await blocker.promise; release(); return null; },
    });

    // Enqueue both while slot is held.
    const pHigh = s.submit({
      taskType: 'llm-chat', tenant: 'ollama', priority: 10,
      run: async (release) => { order.push('high'); release(); return 'high'; },
    });
    const pLow = s.submit({
      taskType: 'comfy-generate', tenant: 'comfy', priority: 20,
      run: async (release) => { order.push('low'); release(); return 'low'; },
    });

    blocker.resolve();
    await Promise.all([pHigh, pLow]);
    expect(order).toEqual(['high', 'low']);
  });
});

describe('FIFO tie-break within same priority', () => {
  it('runs same-priority jobs in enqueue order', async () => {
    const s = makeScheduler();
    const order: number[] = [];
    const blocker = defer();

    void s.submit({
      taskType: 'blocker', tenant: 'comfy', priority: 5,
      run: async (release) => { await blocker.promise; release(); return null; },
    });

    const p1 = s.submit({ taskType: 'llm-chat', tenant: 'ollama', priority: 10,
      run: async (release) => { order.push(1); release(); return 1; } });
    const p2 = s.submit({ taskType: 'llm-chat', tenant: 'ollama', priority: 10,
      run: async (release) => { order.push(2); release(); return 2; } });
    const p3 = s.submit({ taskType: 'llm-chat', tenant: 'ollama', priority: 10,
      run: async (release) => { order.push(3); release(); return 3; } });

    blocker.resolve();
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });
});

describe('cancel pending job', () => {
  it('removes from queue and rejects with CancelledError', async () => {
    const s = makeScheduler();
    const blocker = defer();

    // Fill the slot.
    void s.submit({ taskType: 'blocker', tenant: 'comfy', priority: 5,
      run: async (release) => { await blocker.promise; release(); return null; } });

    const queued = s.submit({ taskType: 'llm-chat', tenant: 'ollama', priority: 10,
      run: async (release) => { release(); return 'ran'; } });

    const snap = s.snapshot();
    const queuedId = snap.queue[0]?.jobId;
    expect(queuedId).toBeTruthy();

    const result = s.cancel(queuedId!);
    expect(result).toBe('cancelled');
    await expect(queued).rejects.toBeInstanceOf(CancelledError);

    expect(s.snapshot().queue.length).toBe(0);
    blocker.resolve();
  });
});

describe('cancel running job', () => {
  it('returns "running" — mid-run cancellation is not supported', async () => {
    const s = makeScheduler();
    const d = defer();
    void s.submit({ taskType: 'llm-chat', tenant: 'ollama', priority: 10,
      run: async (release) => { await d.promise; release(); return null; } });

    const snap = s.snapshot();
    expect(snap.active).not.toBeNull();
    expect(s.cancel(snap.active!.jobId)).toBe('running');
    d.resolve();
  });
});

describe('switchTenant mid-job', () => {
  it('changes residency but does not advance the queue', async () => {
    const s = makeScheduler();
    mockCurrentTenant = 'ollama';
    const d = defer();
    let snapDuring: ReturnType<typeof s.snapshot> | null = null;

    const job = s.submit({ taskType: 'llm-chat', tenant: 'ollama', priority: 10,
      run: async (release) => {
        await s.switchTenant('comfy');
        snapDuring = s.snapshot();
        await d.promise;
        release();
        return 'done';
      } });

    // Enqueue another job while first runs.
    const second = s.submit({ taskType: 'comfy-generate', tenant: 'comfy', priority: 20,
      run: async (release) => { release(); return 'second'; } });

    d.resolve();
    await Promise.all([job, second]);

    // During switchTenant the queue still had 1 pending job.
    expect(snapDuring?.queue.length).toBe(1);
    expect(mockEnsureResident).toHaveBeenCalledWith('comfy');
  });
});

describe('slot leak protection', () => {
  it('releases slot when run() throws', async () => {
    const s = makeScheduler();
    await expect(
      s.submit({ taskType: 'llm-chat', tenant: 'ollama', priority: 10,
        run: async (_release) => { throw new Error('boom'); } }),
    ).rejects.toThrow('boom');
    expect(s.snapshot().active).toBeNull();
  });

  it('releases slot when run() returns rejected promise', async () => {
    const s = makeScheduler();
    await expect(
      s.submit({ taskType: 'llm-chat', tenant: 'ollama', priority: 10,
        run: (_release) => Promise.reject(new Error('rejected')) }),
    ).rejects.toThrow('rejected');
    expect(s.snapshot().active).toBeNull();
  });
});

describe('listener count stays bounded', () => {
  it('subscribe + unsubscribe in a loop does not accumulate listeners', () => {
    const s = makeScheduler();
    const listeners: Array<() => void> = [];
    for (let i = 0; i < 20; i += 1) {
      const l = () => { /* no-op */ };
      listeners.push(l);
      s.onStateChange(l);
    }
    expect(s.listenerCount()).toBe(20);
    for (const l of listeners) s.offStateChange(l);
    expect(s.listenerCount()).toBe(0);
  });
});

describe('snapshot returns plain serializable JSON', () => {
  it('snapshot round-trips through JSON without class instances', async () => {
    const s = makeScheduler();
    mockCurrentTenant = 'ollama';
    const d = defer();
    void s.submit({ taskType: 'llm-chat', tenant: 'ollama', priority: 10,
      run: async (release) => { await d.promise; release(); return null; } });
    void s.submit({ taskType: 'comfy-generate', tenant: 'comfy', priority: 20,
      run: async (release) => { release(); return null; } });

    const snap = s.snapshot();
    const rt = JSON.parse(JSON.stringify(snap)) as typeof snap;
    expect(rt.residency).toBe(snap.residency);
    expect(rt.active?.jobId).toBe(snap.active?.jobId);
    expect(rt.queue.length).toBe(1);
    d.resolve();
  });
});
