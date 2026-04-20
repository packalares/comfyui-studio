// Reset helpers. Clear cache + ComfyUI directory (preserving select
// subdirectories), then optionally invoke the launcher recovery shell script
// if present. All commands go through lib/exec.run with argv-only invocation.

import fs from 'fs';
import path from 'path';
import { env } from '../../config/env.js';
import { run } from '../../lib/exec.js';
import { logger } from '../../lib/logger.js';
import type { ComfyUILogStore } from './log.service.js';

const NORMAL_PRESERVED = ['models', 'output', 'input', 'user', 'custom_nodes'];
const HARD_PRESERVED = ['models', 'output', 'input'];

function preservedDirsFor(mode: 'normal' | 'hard', comfyuiPath: string): string[] {
  const dirs = mode === 'normal' ? [...NORMAL_PRESERVED] : [...HARD_PRESERVED];
  // Preserve data dir if it's nested under the comfyui path.
  const rel = env.DATA_DIR && path.relative(comfyuiPath, env.DATA_DIR);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    dirs.push(path.basename(env.DATA_DIR));
  }
  return dirs;
}

async function removePath(target: string): Promise<void> {
  try {
    await fs.promises.rm(target, { recursive: true, force: true });
  } catch (error) {
    logger.warn('remove failed', {
      target, message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function clearDirectory(dirPath: string, removeSelf = false): Promise<void> {
  if (!fs.existsSync(dirPath)) return;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    await removePath(path.join(dirPath, entry.name));
  }
  if (removeSelf) await removePath(dirPath);
}

export async function clearCacheIfPresent(log: ComfyUILogStore): Promise<void> {
  const cachePath = env.CACHE_DIR;
  if (!cachePath) {
    log.addResetLog('No cache directory configured; skipping cache cleanup');
    return;
  }
  if (!fs.existsSync(cachePath)) {
    log.addResetLog(`Cache directory does not exist: ${cachePath}`);
    return;
  }
  log.addResetLog(`Cleaning cache directory: ${cachePath}`);
  await clearDirectory(cachePath);
}

async function clearOneEntry(
  fullPath: string,
  isDir: boolean,
  name: string,
  log: ComfyUILogStore,
): Promise<void> {
  if (isDir) {
    log.addResetLog(`Deleting directory: ${name}`);
    await clearDirectory(fullPath, true);
  } else {
    log.addResetLog(`Deleting file: ${name}`);
    await removePath(fullPath);
  }
}

export async function clearComfyuiRoot(
  mode: 'normal' | 'hard',
  log: ComfyUILogStore,
): Promise<void> {
  const comfyuiPath = env.COMFYUI_PATH;
  if (!fs.existsSync(comfyuiPath)) {
    log.addResetLog(`ComfyUI path does not exist: ${comfyuiPath}`, true);
    return;
  }
  log.addResetLog(`Cleaning ComfyUI directory: ${comfyuiPath}`);
  const preserved = preservedDirsFor(mode, comfyuiPath);
  log.addResetLog(
    mode === 'normal'
      ? 'Normal mode: preserving models, output, input, user, custom_nodes'
      : 'Hard mode: preserving models, output, input',
  );
  const entries = fs.readdirSync(comfyuiPath, { withFileTypes: true });
  for (const entry of entries) {
    if (preserved.includes(entry.name)) {
      log.addResetLog(`Keeping directory: ${entry.name}`);
      continue;
    }
    const fullPath = path.join(comfyuiPath, entry.name);
    await clearOneEntry(fullPath, entry.isDirectory(), entry.name, log);
  }
}

/**
 * Run the recovery shell script `up-version-cp.sh` if present. The launcher
 * deployment bundled this under /runner-scripts; when absent we silently
 * skip. Errors are logged but do not abort the reset flow.
 */
export async function runRecoveryScript(log: ComfyUILogStore): Promise<void> {
  const script = '/runner-scripts/up-version-cp.sh';
  if (!fs.existsSync(script)) {
    log.addResetLog('No recovery script present; skipping');
    return;
  }
  log.addResetLog('Running recovery script');
  try {
    await run('chmod', ['+x', script], { timeoutMs: 5_000 });
    const result = await run('sh', [script], { timeoutMs: 60_000 });
    if (result.code !== 0) {
      log.addResetLog(`Recovery script exited with code ${result.code}`, true);
      return;
    }
    log.addResetLog('Recovery script completed');
  } catch (error) {
    log.addResetLog(
      `Recovery script failed: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }
}
