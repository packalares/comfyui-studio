// Status shape verification. We mock the underlying building blocks and
// assert the aggregator composes them into the exact contract studio's
// frontend expects.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Mock the dependencies the status service composes.
vi.mock('../../src/services/comfyui/version.service.js', () => ({
  getVersionInfo: vi.fn(),
  getAppVersion: vi.fn(() => '1.0.0'),
  resetVersionCache: vi.fn(),
}));

vi.mock('../../src/services/comfyui/utils.js', () => ({
  isComfyUIRunning: vi.fn(),
  getUptime: vi.fn(),
  getGPUMode: vi.fn(() => 'exclusive'),
}));

import { getStatus } from '../../src/services/comfyui/status.service.js';
import * as versionModule from '../../src/services/comfyui/version.service.js';
import * as utilsModule from '../../src/services/comfyui/utils.js';
import { setProcessService, getProcessService } from '../../src/services/comfyui/singleton.js';

class FakeProcessService {
  pid: number | null = null;
  startTime: Date | null = null;
  getComfyPid() { return this.pid; }
  getStartTime() { return this.startTime; }
  getLogStore() { return { getRecentLogs: () => [] as string[], getResetLogs: () => [] as string[] }; }
  checkIfComfyUIRunning() { return Promise.resolve(); }
}

describe('status.service.getStatus', () => {
  beforeEach(() => {
    setProcessService(new FakeProcessService() as unknown as ReturnType<typeof getProcessService>);
    vi.mocked(versionModule.getVersionInfo).mockReset();
    vi.mocked(utilsModule.isComfyUIRunning).mockReset();
    vi.mocked(utilsModule.getUptime).mockReset();
  });

  afterEach(() => { setProcessService(null); });

  it('returns a fully-shaped status when running', async () => {
    const svc = getProcessService() as unknown as FakeProcessService;
    svc.pid = 123;
    svc.startTime = new Date(Date.now() - 10_000);
    vi.mocked(utilsModule.isComfyUIRunning).mockResolvedValue(true);
    vi.mocked(utilsModule.getUptime).mockReturnValue('10s');
    vi.mocked(versionModule.getVersionInfo).mockResolvedValue({ comfyui: '0.2.0', frontend: 'v1.0.0' });
    const s = await getStatus();
    expect(s.running).toBe(true);
    expect(s.pid).toBe(123);
    expect(s.uptime).toBe('10s');
    expect(s.versions.comfyui).toBe('0.2.0');
    expect(s.versions.frontend).toBe('v1.0.0');
    expect(s.versions.app).toBe('1.0.0');
    expect(s.gpuMode).toBe('exclusive');
  });

  it('uptime is null when stopped', async () => {
    vi.mocked(utilsModule.isComfyUIRunning).mockResolvedValue(false);
    vi.mocked(versionModule.getVersionInfo).mockResolvedValue({});
    const s = await getStatus();
    expect(s.running).toBe(false);
    expect(s.uptime).toBeNull();
  });

  it('unknown versions fall back to "unknown"', async () => {
    vi.mocked(utilsModule.isComfyUIRunning).mockResolvedValue(false);
    vi.mocked(versionModule.getVersionInfo).mockResolvedValue({});
    const s = await getStatus();
    expect(s.versions.comfyui).toBe('unknown');
    expect(s.versions.frontend).toBe('unknown');
  });

  it('pid is preserved via getComfyPid', async () => {
    const svc = getProcessService() as unknown as FakeProcessService;
    svc.pid = 42;
    svc.startTime = new Date();
    vi.mocked(utilsModule.isComfyUIRunning).mockResolvedValue(true);
    vi.mocked(utilsModule.getUptime).mockReturnValue('5s');
    vi.mocked(versionModule.getVersionInfo).mockResolvedValue({ comfyui: 'x', frontend: 'y' });
    const s = await getStatus();
    expect(s.pid).toBe(42);
  });
});
