// Facade for the launcher system controller. Ports `system.controller.ts`
// without the Olares-specific open-path side effects — those required an
// intent HTTP call to a desktop bridge that is not present in the studio
// deployment. We keep the endpoint shape (request body + response body)
// intact but treat the request as a no-op when neither
// `env.OS_SYSTEM_SERVER` nor `env.DESKTOP_API_URL` is configured, logging
// for observability. Callers that DO configure the bridge continue to
// trigger an HTTP POST to it.

import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { safeResolve } from '../../lib/fs.js';
import { paths } from '../../config/paths.js';
import * as liveSettings from './liveSettings.js';

export interface OpenPathResult {
  code: number;
  message: string;
  data: null;
}

/**
 * `/api/system/open-path`
 *
 * Launcher: asks the Olares desktop bridge to open `path` in the host
 * file manager. We preserve the response shape so existing clients keep
 * working, but only forward the request when a bridge URL is configured.
 * The path is guarded against traversal by requiring it to resolve under
 * one of the declared roots.
 */
export async function openPath(requestedPath: string): Promise<OpenPathResult> {
  if (!requestedPath) {
    return { code: 400, message: 'path required', data: null };
  }
  if (!isPathSafe(requestedPath)) {
    logger.warn('openPath: rejected path outside declared roots', { path: requestedPath });
    return { code: 403, message: 'path outside allowed roots', data: null };
  }
  const bridge = env.DESKTOP_API_URL || (env.OS_SYSTEM_SERVER
    ? `http://${env.OS_SYSTEM_SERVER}/legacy/v1alpha1/api.intent/v1/server/intent/send`
    : '');
  if (!bridge) {
    // No bridge configured: log and return success. Frontend tolerates this.
    logger.info('openPath: no desktop bridge configured, no-op', { path: requestedPath });
    return { code: 200, message: 'ok', data: null };
  }
  try {
    await sendBridgeRequest(bridge, requestedPath);
    return { code: 200, message: 'ok', data: null };
  } catch (err) {
    logger.warn('openPath: bridge call failed', { error: String(err) });
    return { code: 500, message: 'bridge call failed', data: null };
  }
}

function isPathSafe(requested: string): boolean {
  // We constrain to configured roots only: the studio data dir plus the
  // models/plugins roots that paths.ts exposes. A missing root simply
  // disables that check branch — we never widen the allow-list.
  const roots = [
    paths.configRoot,
    paths.runtimeStateDir,
    paths.dataDir,
    env.COMFYUI_PATH,
    env.MODELS_DIR,
  ].filter(Boolean);
  for (const root of roots) {
    try {
      safeResolve(root, requested);
      return true;
    } catch { /* try next root */ }
  }
  return false;
}

async function sendBridgeRequest(bridge: string, requestedPath: string): Promise<void> {
  const body = JSON.stringify({
    action: 'view',
    category: 'default',
    data: { path: requestedPath },
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const r = await fetch(bridge, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body,
      signal: controller.signal,
    });
    if (!r.ok) throw new Error(`bridge HTTP ${r.status}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `/api/system/files-base-path` — launcher returns the base directory the
 * file browser should open at. Driven by NODENAME; matches the launcher's
 * template exactly.
 */
export function getFilesBasePath(): { basePath: string } {
  const nodeName = env.NODENAME || 'default';
  return { basePath: `/Files/External/${nodeName}/ai/` };
}

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
