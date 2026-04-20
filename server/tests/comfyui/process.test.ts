// Process lifecycle: assert orchestration sequence without spawning Python.
// We mock the spawn helper, the port probe, the kill ladder, and the reset
// helpers, then inspect the call order.

import { describe, expect, it, vi, beforeEach } from 'vitest';

// ---- Mocks must be declared before the SUT import so vitest hoists them. ----
const mockSpawnComfyUI = vi.fn();
const mockResolveCliArgs = vi.fn();
const mockBuildChildEnv = vi.fn();
const mockIsRunning = vi.fn();
const mockKillGeneric = vi.fn();
const mockSleep = vi.fn();
const mockRun = vi.fn();
const mockClearCache = vi.fn();
const mockClearRoot = vi.fn();
const mockRunRecovery = vi.fn();

vi.mock('../../src/services/comfyui/process.spawn.js', () => ({
  spawnComfyUI: mockSpawnComfyUI,
  resolveCliArgs: mockResolveCliArgs,
  buildChildEnv: mockBuildChildEnv,
}));
vi.mock('../../src/services/comfyui/utils.js', () => ({
  isComfyUIRunning: mockIsRunning,
  getUptime: vi.fn((t: Date | null) => (t ? '1s' : '0s')),
  getGPUMode: vi.fn(() => 'exclusive'),
}));
vi.mock('../../src/services/comfyui/process.stop.js', () => ({
  killComfyUIGeneric: mockKillGeneric,
  sleep: mockSleep,
}));
vi.mock('../../src/services/comfyui/process.reset.js', () => ({
  clearCacheIfPresent: mockClearCache,
  clearComfyuiRoot: mockClearRoot,
  runRecoveryScript: mockRunRecovery,
}));
vi.mock('../../src/lib/exec.js', () => ({
  run: mockRun,
  runOrThrow: vi.fn(),
}));

// Import after mocks are declared.
const { ProcessService } = await import('../../src/services/comfyui/process.service.js');
const { LogService } = await import('../../src/services/comfyui/log.service.js');

function makeFakeChild() {
  const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
  return {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn((ev: string, cb: (...a: unknown[]) => void) => {
      const arr = listeners.get(ev) || [];
      arr.push(cb);
      listeners.set(ev, arr);
    }),
    kill: vi.fn(),
    _listeners: listeners,
  };
}

describe('ProcessService lifecycle', () => {
  beforeEach(() => {
    mockSpawnComfyUI.mockReset();
    mockIsRunning.mockReset();
    mockKillGeneric.mockReset();
    mockSleep.mockReset().mockResolvedValue(undefined);
    mockRun.mockReset().mockResolvedValue({ stdout: '', stderr: '', code: 0, signal: null, timedOut: false });
    mockClearCache.mockReset().mockResolvedValue(undefined);
    mockClearRoot.mockReset().mockResolvedValue(undefined);
    mockRunRecovery.mockReset().mockResolvedValue(undefined);
  });

  it('startComfyUI short-circuits when already running', async () => {
    mockIsRunning.mockResolvedValue(true);
    const svc = new ProcessService(new LogService());
    const r = await svc.startComfyUI();
    expect(r.success).toBe(false);
    expect(r.message.toLowerCase().includes('already running')).toBe(true);
    expect(mockSpawnComfyUI).not.toHaveBeenCalled();
  });

  it('startComfyUI spawns then polls until running', async () => {
    // Not running at pre-check; running after spawn.
    mockIsRunning.mockResolvedValueOnce(false).mockResolvedValue(true);
    const fake = makeFakeChild();
    mockSpawnComfyUI.mockReturnValue({
      process: fake, argv: ['bash', '/fake.sh'], cliArgs: '--lowvram', startedAt: new Date(),
    });
    const svc = new ProcessService(new LogService());
    const r = await svc.startComfyUI();
    expect(mockSpawnComfyUI).toHaveBeenCalledTimes(1);
    expect(r.success).toBe(true);
  });

  it('stopComfyUI is a no-op when not running', async () => {
    mockIsRunning.mockResolvedValue(false);
    const svc = new ProcessService(new LogService());
    const r = await svc.stopComfyUI();
    expect(r.success).toBe(true);
    expect(mockKillGeneric).not.toHaveBeenCalled();
  });

  it('stopComfyUI invokes the kill ladder when running', async () => {
    // First probe: running; after kill + sleep, probe resolves to false.
    mockIsRunning.mockResolvedValueOnce(true).mockResolvedValue(false);
    mockKillGeneric.mockResolvedValue(undefined);
    const svc = new ProcessService(new LogService());
    const r = await svc.stopComfyUI();
    expect(mockKillGeneric).toHaveBeenCalledTimes(1);
    expect(r.success).toBe(true);
  });

  it('restartComfyUI chains stop then start', async () => {
    // 1st probe (stop pre-check): running
    // 2nd probe (stop post-check): stopped
    // 3rd probe (start pre-check): stopped
    // 4th+ probes (start wait): running
    mockIsRunning
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    mockKillGeneric.mockResolvedValue(undefined);
    const fake = makeFakeChild();
    mockSpawnComfyUI.mockReturnValue({
      process: fake, argv: ['bash', '/fake.sh'], cliArgs: '', startedAt: new Date(),
    });
    const svc = new ProcessService(new LogService());
    const r = await svc.restartComfyUI();
    expect(mockKillGeneric).toHaveBeenCalled();
    expect(mockSpawnComfyUI).toHaveBeenCalled();
    expect(r.success).toBe(true);
  });

  it('resetComfyUI runs cache+root+recovery in order', async () => {
    mockIsRunning.mockResolvedValue(false);
    const order: string[] = [];
    mockClearCache.mockImplementation(async () => { order.push('cache'); });
    mockClearRoot.mockImplementation(async () => { order.push('root'); });
    mockRunRecovery.mockImplementation(async () => { order.push('recovery'); });
    const svc = new ProcessService(new LogService());
    const r = await svc.resetComfyUI('hard');
    expect(r.success).toBe(true);
    expect(order).toEqual(['cache', 'root', 'recovery']);
    expect(mockClearRoot.mock.calls[0][0]).toBe('hard');
  });
});
