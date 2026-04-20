// system.service facade coverage: open-path guard, files-base-path shape,
// network-config projection.

import { describe, expect, it } from 'vitest';

// Ensure no desktop bridge is configured so openPath exercises the
// no-op branch (log-only, 200). We explicitly clear both env vars so
// whatever the harness inherits cannot leak an external URL into the test.
process.env.OS_SYSTEM_SERVER = '';
process.env.DESKTOP_API_URL = '';
process.env.NODENAME = 'test-node';

const system = await import('../../src/services/systemLauncher/system.service.js');

describe('system.getFilesBasePath', () => {
  it('uses NODENAME from env', () => {
    expect(system.getFilesBasePath().basePath).toBe('/Files/External/test-node/ai/');
  });
});

describe('system.openPath', () => {
  it('returns 400 for missing path', async () => {
    const r = await system.openPath('');
    expect(r.code).toBe(400);
  });

  it('accepts a path under the configured roots (no bridge -> 200 no-op)', async () => {
    // The test harness's COMFYUI_PATH default is /root/ComfyUI; safeResolve
    // accepts relative segments under it.
    const r = await system.openPath('models/checkpoints');
    expect(r.code).toBe(200);
  });

  it('rejects traversal outside all declared roots', async () => {
    const r = await system.openPath('/etc/passwd');
    // Absolute path outside configroot/dataDir/COMFYUI_PATH/MODELS_DIR.
    expect([400, 403]).toContain(r.code);
  });
});

describe('system.getNetworkConfig', () => {
  it('reports defaults when last-status is null', () => {
    const r = system.getNetworkConfig(null);
    expect(r.huggingfaceEndpoint).toMatch(/huggingface/);
    expect(r.githubProxy).toMatch(/github/);
    expect(r.pipSource).toMatch(/pypi/);
    expect(r.reachability.github.accessible).toBe(false);
    expect(r.reachability.pip.accessible).toBe(false);
    expect(r.reachability.huggingface.accessible).toBe(false);
    expect(Array.isArray(r.pluginTrustedHosts)).toBe(true);
    expect(typeof r.allowPrivateIpMirrors).toBe('boolean');
  });

  it('merges accessibility flags from last-status', () => {
    const r = system.getNetworkConfig({
      github: { accessible: true, latencyMs: 40 },
      pip: { accessible: false },
      huggingface: { accessible: true, latencyMs: 60 },
    });
    expect(r.reachability.github.accessible).toBe(true);
    expect(r.reachability.pip.accessible).toBe(false);
    expect(r.reachability.huggingface.accessible).toBe(true);
    expect(r.reachability.github.latencyMs).toBe(40);
  });
});
