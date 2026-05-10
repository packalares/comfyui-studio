// ComfyUI status aggregator: version info, types, and getStatus.
// Field names in ComfyUIStatus are load-bearing — frontend's LauncherStatus
// consumes this shape and must not drift.

import fs from 'fs';
import path from 'path';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { run } from '../../lib/exec.js';
import { getGPUMode, getUptime, isComfyUIRunning } from './utils.js';
import { getProcessService } from './process.js';

// ---- Version cache ----

const VERSION_CACHE_TIMEOUT_MS = 600_000; // 10 minutes

interface CachedVersions {
  comfyui?: string;
  frontend?: string;
  timestamp?: number;
}

let cache: CachedVersions = {};

/** Test helper: clear the module-level cache. */
export function resetVersionCache(): void {
  cache = {};
}

async function readComfyuiVersion(comfyuiPath: string): Promise<string | undefined> {
  const versionPy = path.join(comfyuiPath, 'comfyui_version.py');
  if (fs.existsSync(versionPy)) {
    try {
      const content = fs.readFileSync(versionPy, 'utf-8');
      const m = content.match(/__version__\s*=\s*["']([^"']+)["']/);
      if (m && m[1]) return m[1];
    } catch { /* fall through */ }
  }
  const legacy = path.join(comfyuiPath, 'version');
  if (fs.existsSync(legacy)) {
    try { return fs.readFileSync(legacy, 'utf-8').trim(); } catch { /* fall through */ }
  }
  try {
    const r = await run('git', ['describe', '--tags'], { cwd: comfyuiPath, timeoutMs: 5_000 });
    if (r.code === 0 && r.stdout.trim()) return r.stdout.trim();
  } catch { /* no git / not a repo */ }
  const pkgJson = path.join(comfyuiPath, 'package.json');
  if (fs.existsSync(pkgJson)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(pkgJson, 'utf-8')) as { version?: string };
      if (parsed.version) return parsed.version;
    } catch { /* ignore */ }
  }
  return undefined;
}

function readFrontendFromCliArgs(): string | undefined {
  const cliArgs = env.CLI_ARGS;
  if (!cliArgs) return undefined;
  const m = cliArgs.match(/--front-end-version\s+[^@]+@(v[\d.]+)/);
  return m && m[1] ? m[1] : undefined;
}

function readFrontendFromBundle(comfyuiPath: string): string | undefined {
  const indexHtml = path.join(comfyuiPath, 'web', 'index.html');
  if (fs.existsSync(indexHtml)) {
    try {
      const html = fs.readFileSync(indexHtml, 'utf-8');
      const m = html.match(/ComfyUI\s+v([\d.]+)/i) || html.match(/version:\s*["']([\d.]+)["']/i);
      if (m && m[1]) return m[1];
    } catch { /* fall through */ }
  }
  const appJs = path.join(comfyuiPath, 'web', 'scripts', 'app.js');
  if (fs.existsSync(appJs)) {
    try {
      const src = fs.readFileSync(appJs, 'utf-8');
      const m = src.match(/version:\s*["']([\d.]+)["']/i)
        || src.match(/APP_VERSION\s*=\s*["']([\d.]+)["']/i);
      if (m && m[1]) return m[1];
    } catch { /* ignore */ }
  }
  return undefined;
}

export async function getVersionInfo(): Promise<{ comfyui?: string; frontend?: string }> {
  const now = Date.now();
  if (cache.timestamp && (now - cache.timestamp) < VERSION_CACHE_TIMEOUT_MS) {
    return { comfyui: cache.comfyui, frontend: cache.frontend };
  }
  const result: { comfyui?: string; frontend?: string } = {};
  try {
    const comfyuiPath = env.COMFYUI_PATH;
    if (comfyuiPath && fs.existsSync(comfyuiPath)) {
      result.comfyui = await readComfyuiVersion(comfyuiPath);
    }
    result.frontend = readFrontendFromCliArgs();
    if (!result.frontend && env.COMFYUI_PATH && fs.existsSync(env.COMFYUI_PATH)) {
      result.frontend = readFrontendFromBundle(env.COMFYUI_PATH);
    }
    cache = { ...result, timestamp: now };
  } catch (error) {
    logger.error('version read failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return result;
}

export const APP_VERSION = '1.0.0';
export function getAppVersion(): string { return APP_VERSION; }

// ---- Types ----

export interface ComfyUIStatus {
  running: boolean;
  pid: number | null;
  uptime: string | null;
  versions: {
    comfyui: string;
    frontend: string;
    app: string;
  };
  gpuMode: string;
}

// ---- Version provider (injectable for tests) ----

interface VersionProvider {
  getVersionInfo: () => Promise<{ comfyui?: string; frontend?: string }>;
  getAppVersion: () => string;
}

let _versionProvider: VersionProvider | null = null;

/** Test helper: inject a mock version provider. Pass null to restore defaults. */
export function setVersionProvider(p: VersionProvider | null): void {
  _versionProvider = p;
}

function versionProvider(): VersionProvider {
  return _versionProvider ?? { getVersionInfo, getAppVersion };
}

// ---- Status aggregator ----

export async function getStatus(): Promise<ComfyUIStatus> {
  const svc = getProcessService();
  const running = await isComfyUIRunning();
  const startTime = svc.getStartTime();
  const uptime = running && startTime ? getUptime(startTime) : null;
  const vp = versionProvider();
  const versions = await vp.getVersionInfo();
  return {
    running,
    pid: svc.getComfyPid(),
    uptime,
    versions: {
      comfyui: versions.comfyui || 'unknown',
      frontend: versions.frontend || 'unknown',
      app: vp.getAppVersion(),
    },
    gpuMode: getGPUMode(),
  };
}
