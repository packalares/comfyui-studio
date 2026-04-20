// pip package install / uninstall / list. All subprocess invocations go
// through `lib/exec.run` with argv-only arguments (never a shell string).
// Ports launcher's python.controller `installPackage`, `uninstallPackage`,
// `getInstalledPackages`, and `getInstalledPackagesData`.

import { env } from '../../config/env.js';
import { run } from '../../lib/exec.js';
import { logger } from '../../lib/logger.js';

export interface InstalledPackage {
  name: string;
  version: string;
}

const PIP_INSTALL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const PIP_UNINSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const PIP_LIST_TIMEOUT_MS = 60_000;

function python(): string { return env.PYTHON_PATH || 'python3'; }

/** Run `python -m pip list --format=json` and parse. */
export async function listInstalledPackages(): Promise<InstalledPackage[]> {
  const r = await run(python(), ['-m', 'pip', 'list', '--format=json'], {
    timeoutMs: PIP_LIST_TIMEOUT_MS,
  });
  if (r.code !== 0) {
    throw new Error(`pip list failed: ${r.stderr || r.stdout}`);
  }
  try {
    const parsed = JSON.parse(r.stdout) as Array<{ name?: unknown; version?: unknown }>;
    return parsed
      .filter((p) => typeof p.name === 'string' && typeof p.version === 'string')
      .map((p) => ({ name: String(p.name), version: String(p.version) }));
  } catch (err) {
    throw new Error(`pip list JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Install a package via pip. `packageSpec` is split on whitespace so a user
 * can pass `"foo==1.2.3 --upgrade"` — matches launcher behaviour exactly, but
 * with argv-only exec and no shell interpolation.
 */
export async function installPackage(
  packageSpec: string,
): Promise<{ output: string }> {
  if (!packageSpec || typeof packageSpec !== 'string') {
    throw new Error('Package name is required');
  }
  const parts = packageSpec.trim().split(/\s+/).filter((p) => p.length > 0);
  if (parts.length === 0) throw new Error('Package name is required');
  const args = ['-m', 'pip', 'install', '--user', ...parts];
  logger.info('pip install', { args });
  const r = await run(python(), args, { timeoutMs: PIP_INSTALL_TIMEOUT_MS });
  if (r.code !== 0) {
    throw new Error(`pip install failed: ${r.stderr || r.stdout}`);
  }
  return { output: r.stdout };
}

/** Uninstall a single package with `pip uninstall -y <name>`. */
export async function uninstallPackage(
  packageName: string,
): Promise<{ output: string }> {
  if (!packageName || typeof packageName !== 'string') {
    throw new Error('Package name is required');
  }
  const trimmed = packageName.trim();
  // Refuse whitespace / flags so the invocation is bounded to a single package.
  if (/\s/.test(trimmed) || trimmed.startsWith('-')) {
    throw new Error('Invalid package name');
  }
  const args = ['-m', 'pip', 'uninstall', '-y', trimmed];
  logger.info('pip uninstall', { args });
  const r = await run(python(), args, { timeoutMs: PIP_UNINSTALL_TIMEOUT_MS });
  if (r.code !== 0) {
    throw new Error(`pip uninstall failed: ${r.stderr || r.stdout}`);
  }
  return { output: r.stdout };
}

/** Install a requirements.txt file. Caller must have validated the path. */
export async function installRequirements(
  requirementsFile: string,
): Promise<{ output: string }> {
  const args = ['-m', 'pip', 'install', '--user', '-r', requirementsFile, '--no-cache-dir'];
  logger.info('pip install -r', { args });
  const r = await run(python(), args, { timeoutMs: PIP_INSTALL_TIMEOUT_MS });
  if (r.code !== 0) {
    throw new Error(`pip install -r failed: ${r.stderr || r.stdout}`);
  }
  return { output: r.stdout };
}
