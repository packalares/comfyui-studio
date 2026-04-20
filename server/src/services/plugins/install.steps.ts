// Per-plugin install steps: git-clone, pip install, install.py, cleanup.
// Every subprocess invocation flows through `lib/exec.run` (argv, no shell).

import fs from 'fs';
import path from 'path';
import { env } from '../../config/env.js';
import { run } from '../../lib/exec.js';
import { safeResolve } from '../../lib/fs.js';
import { logger } from '../../lib/logger.js';

const GIT_CLONE_TIMEOUT_MS = 60_000;
const PIP_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const SCRIPT_TIMEOUT_MS = 5 * 60 * 1000;

function python(): string { return env.PYTHON_PATH || 'python3'; }

export type LogFn = (message: string) => void;

/** Clone a URL into `targetDir`. Fails fast on non-zero exit code. */
export async function gitClone(
  url: string,
  targetDir: string,
  branch: string | undefined,
  log: LogFn,
): Promise<void> {
  const args = ['clone'];
  if (branch) args.push('--branch', branch);
  args.push(url, targetDir);
  log(`Executing: git ${args.join(' ')}`);
  const r = await run('git', args, { timeoutMs: GIT_CLONE_TIMEOUT_MS });
  if (r.stdout) log(`git stdout: ${r.stdout.trim()}`);
  if (r.stderr) log(`git stderr: ${r.stderr.trim()}`);
  if (r.code !== 0 || r.timedOut) {
    throw new Error(`git clone failed (code=${r.code}${r.timedOut ? ', timeout' : ''})`);
  }
}

/** Run `git fetch --all --tags && git checkout <version>` inside the clone. */
export async function gitCheckoutVersion(
  targetDir: string,
  version: string,
  log: LogFn,
): Promise<void> {
  log(`Checkout: ${version}`);
  const fetchResult = await run('git', ['fetch', '--all', '--tags'], {
    cwd: targetDir,
    timeoutMs: GIT_CLONE_TIMEOUT_MS,
  });
  if (fetchResult.stderr) log(`git fetch stderr: ${fetchResult.stderr.trim()}`);
  const r = await run('git', ['checkout', version], {
    cwd: targetDir,
    timeoutMs: GIT_CLONE_TIMEOUT_MS,
  });
  if (r.stdout) log(`git checkout stdout: ${r.stdout.trim()}`);
  if (r.stderr) log(`git checkout stderr: ${r.stderr.trim()}`);
  if (r.code !== 0) throw new Error(`git checkout ${version} failed`);
}

/** Install a plugin's requirements.txt via pip. Called after a successful clone. */
export async function pipInstallRequirements(
  pluginDir: string,
  log: LogFn,
): Promise<void> {
  let reqPath: string;
  try { reqPath = safeResolve(pluginDir, 'requirements.txt'); }
  catch { log('Skipping requirements: path escaped plugin dir'); return; }
  if (!fs.existsSync(reqPath)) { log('No requirements.txt'); return; }
  const args = ['-m', 'pip', 'install', '--user', '-r', reqPath, '--no-cache-dir'];
  log(`Executing: ${python()} ${args.join(' ')}`);
  const r = await run(python(), args, { timeoutMs: PIP_INSTALL_TIMEOUT_MS });
  if (r.stdout) log(`pip stdout: ${r.stdout.trim()}`);
  if (r.stderr) log(`pip stderr: ${r.stderr.trim()}`);
  if (r.code !== 0) log(`pip install failed (code=${r.code}), continuing`);
}

/** Run `python install.py` inside the plugin dir when present. */
export async function runInstallScript(pluginDir: string, log: LogFn): Promise<void> {
  let scriptPath: string;
  try { scriptPath = safeResolve(pluginDir, 'install.py'); }
  catch { return; }
  if (!fs.existsSync(scriptPath)) { log('No install.py'); return; }
  log(`Executing: ${python()} ${scriptPath}`);
  const r = await run(python(), [scriptPath], {
    cwd: pluginDir,
    timeoutMs: SCRIPT_TIMEOUT_MS,
  });
  if (r.stdout) log(`install.py stdout: ${r.stdout.trim()}`);
  if (r.stderr) log(`install.py stderr: ${r.stderr.trim()}`);
  if (r.code !== 0) log(`install.py failed (code=${r.code}), continuing`);
}

/** Remove a plugin dir recursively via fs.promises.rm. Never through shell. */
export async function removePluginDir(pluginDir: string): Promise<void> {
  await fs.promises.rm(pluginDir, { recursive: true, force: true });
}

/** Rename the existing plugin dir to `<dir>_backup_<ts>` so install can retry. */
export function backupPluginDir(pluginDir: string, log: LogFn): string | null {
  if (!fs.existsSync(pluginDir)) return null;
  const backup = `${pluginDir}_backup_${Date.now()}`;
  fs.renameSync(pluginDir, backup);
  log(`Backup: ${path.basename(backup)}`);
  return backup;
}

/** Best-effort cleanup of a backup directory once install has succeeded. */
export async function removeBackup(backupDir: string | null, log: LogFn): Promise<void> {
  if (!backupDir) return;
  try { await fs.promises.rm(backupDir, { recursive: true, force: true }); }
  catch (err) {
    logger.warn('plugin backup cleanup failed', { message: err instanceof Error ? err.message : String(err) });
    log(`Backup cleanup failed (ignored): ${err instanceof Error ? err.message : String(err)}`);
  }
}
