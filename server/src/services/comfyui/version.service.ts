// Read ComfyUI / frontend / app version strings. Cached for 10 minutes.
//
// Preference order (matches launcher behaviour):
// 1. comfyui/comfyui_version.py (__version__ = "x.y.z")
// 2. comfyui/version file
// 3. `git describe --tags` inside the comfyui checkout
// 4. comfyui/package.json
// For frontend: env.CLI_ARGS `--front-end-version Foo@vX.Y.Z` wins, else
// probe web/index.html, web/scripts/app.js.

import fs from 'fs';
import path from 'path';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { run } from '../../lib/exec.js';
import { APP_VERSION, VERSION_CACHE_TIMEOUT_MS } from './types.js';

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

export function getAppVersion(): string {
  return APP_VERSION;
}
