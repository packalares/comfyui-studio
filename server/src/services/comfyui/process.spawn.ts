// Spawn helpers for the ComfyUI process. Command assembly is delegated to
// `/runner-scripts/entrypoint.sh` + env CLI_ARGS. If CLI args are empty we
// fall back to env.CLI_ARGS so orchestrator defaults aren't wiped.

import { type ChildProcess, spawn } from 'child_process';
import { env, currentProcessEnv } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { buildCliArgsString } from './launchOptions.service.js';

export interface SpawnContext {
  process: ChildProcess;
  argv: string[];
  cliArgs: string;
  startedAt: Date;
}

/**
 * Return the CLI argument string used for the next spawn. Prefers the
 * persisted launch-options config; falls back to env.CLI_ARGS so k8s-defined
 * defaults survive a config wipe.
 */
export function resolveCliArgs(): string {
  const fromConfig = buildCliArgsString().trim();
  if (fromConfig) return fromConfig;
  return (env.CLI_ARGS || '').trim();
}

/**
 * Build the env map passed to the ComfyUI child process. Inherits the current
 * environment so HF_ENDPOINT, PIP_INDEX_URL, NVIDIA_VISIBLE_DEVICES, etc.
 * propagate, then overlays the resolved CLI_ARGS.
 */
export function buildChildEnv(cliArgs: string): NodeJS.ProcessEnv {
  return { ...currentProcessEnv(), CLI_ARGS: cliArgs };
}

/**
 * Spawn the ComfyUI runner via bash entrypoint. stdio is piped so the caller
 * can attach log taps. The returned handle mirrors the launcher's original
 * shape so the surrounding orchestration (wait-for-port, retries, kill
 * ladder) is unchanged.
 */
export function spawnComfyUI(): SpawnContext {
  const cliArgs = resolveCliArgs();
  const argv = ['bash', env.COMFYUI_ENTRYPOINT];
  const childEnv = buildChildEnv(cliArgs);
  logger.info('comfyui spawn', { entrypoint: env.COMFYUI_ENTRYPOINT, hasCliArgs: cliArgs.length > 0 });
  const child = spawn(argv[0], argv.slice(1), {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv,
    shell: false,
    windowsHide: true,
  });
  return { process: child, argv, cliArgs, startedAt: new Date() };
}
