// Facade for the launcher system controller. Provides the network-config
// projection consumed by `GET /api/system/network-config`, combining live
// URL settings, plugin trust policy, and the latest reachability snapshot.

import * as liveSettings from './liveSettings.js';

export interface NetworkConfigView {
  /** Flat keys the frontend NetworkCard reads directly. */
  huggingfaceEndpoint: string;
  githubProxy: string;
  pipSource: string;
  /** Extra hosts accepted by the plugin-install URL validator. */
  pluginTrustedHosts: string[];
  /** Extra hosts accepted by the model-download URL validator. */
  modelTrustedHosts: string[];
  /** When true, pip-source accepts http:// on private IPs. */
  allowPrivateIpMirrors: boolean;
  /** Last-known reachability for each service (unknown until the first check runs). */
  reachability: {
    github: { url: string; accessible: boolean; latencyMs?: number };
    pip: { url: string; accessible: boolean; latencyMs?: number };
    huggingface: { url: string; accessible: boolean; latencyMs?: number };
  };
}

type ReachabilityStatus = Record<string, { accessible: boolean; latencyMs?: number }>;

/**
 * `/api/system/network-config` — combines live URL settings, plugin trust
 * policy, and the most recent network check so the frontend can render a
 * single, self-contained "Network" card without making multiple requests.
 *
 * The response is intentionally flat at the top level (`huggingfaceEndpoint`
 * etc.) because the current frontend NetworkCard reads those keys directly;
 * the nested `reachability` block is additive and ignored by older clients.
 */
export function getNetworkConfig(lastStatus: ReachabilityStatus | null): NetworkConfigView {
  const snap = liveSettings.snapshot();
  return {
    huggingfaceEndpoint: snap.hfEndpoint || 'https://huggingface.co/',
    githubProxy: snap.githubProxy || 'https://github.com/',
    pipSource: snap.pipSource || 'https://pypi.org/simple/',
    pluginTrustedHosts: snap.pluginTrustedHosts,
    modelTrustedHosts: snap.modelTrustedHosts,
    allowPrivateIpMirrors: snap.allowPrivateIpMirrors,
    reachability: {
      github: {
        url: snap.githubProxy || 'https://github.com/',
        accessible: lastStatus?.github?.accessible ?? false,
        latencyMs: lastStatus?.github?.latencyMs,
      },
      pip: {
        url: snap.pipSource || 'https://pypi.org/simple/',
        accessible: lastStatus?.pip?.accessible ?? false,
        latencyMs: lastStatus?.pip?.latencyMs,
      },
      huggingface: {
        url: snap.hfEndpoint || 'https://huggingface.co/',
        accessible: lastStatus?.huggingface?.accessible ?? false,
        latencyMs: lastStatus?.huggingface?.latencyMs,
      },
    },
  };
}
