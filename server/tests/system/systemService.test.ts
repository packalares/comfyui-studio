// system.service facade coverage: network-config projection.

import { describe, expect, it } from 'vitest';

process.env.NODENAME = 'test-node';

const system = await import('../../src/services/systemLauncher/system.service.js');

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
