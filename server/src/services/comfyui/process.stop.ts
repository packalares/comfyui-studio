// Stop helpers. The launcher picked pids from `ps aux` then issued `kill -9`,
// falling back to `pkill -9 -f python`. We preserve the ladder but route
// everything through `lib/exec.run` so shell interpolation is impossible.

import { run } from '../../lib/exec.js';
import { logger } from '../../lib/logger.js';

/** Sleep for ms. Rejects never. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function collectComfyPids(): Promise<number[]> {
  // `ps -eo pid,rss,command` is portable across linux and darwin.
  const r = await run('ps', ['-eo', 'pid,rss,command'], { timeoutMs: 5_000 });
  if (r.code !== 0) return [];
  const out: number[] = [];
  for (const line of r.stdout.split('\n').slice(1)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 3) continue;
    const pid = parseInt(parts[0], 10);
    const rss = parseInt(parts[1], 10);
    const cmd = parts.slice(2).join(' ');
    if (!Number.isFinite(pid)) continue;
    // Launcher heuristic: python processes using >100MB RSS are likely comfyui.
    if (cmd.includes('python') && Number.isFinite(rss) && rss > 100_000) {
      out.push(pid);
    }
  }
  return out;
}

async function killPid(pid: number, signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
  try {
    process.kill(pid, signal);
  } catch (error) {
    logger.warn('kill failed', {
      pid, signal, message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Graceful-first stop. Send SIGTERM to discovered python processes, wait
 * `graceMs`, then SIGKILL survivors. Final fallback mirrors launcher:
 * `pkill -9 -f python` invoked argv-safe.
 */
export async function killComfyUIGeneric(graceMs: number): Promise<void> {
  const pids = await collectComfyPids();
  if (pids.length > 0) {
    logger.info('comfyui stop: found python processes', { pids });
    for (const pid of pids) await killPid(pid, 'SIGTERM');
    await sleep(graceMs);
    const survivors = await collectComfyPids();
    for (const pid of survivors) await killPid(pid, 'SIGKILL');
    return;
  }
  // Fallback: broad pkill. Arg-safe (no shell interpolation).
  logger.info('comfyui stop: falling back to pkill');
  await run('pkill', ['-9', '-f', 'python'], { timeoutMs: 5_000 }).catch(() => { /* ignore */ });
}
