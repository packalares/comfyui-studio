// Safe child-process helper. Absorbs launcher's `utils/execPromise.ts`.
//
// Launcher's version was `util.promisify(child_process.exec)` which takes a
// shell string — that is fundamentally unsafe because callers composed
// argv fragments via string concatenation. The ported API is argv-only:
// callers pass `cmd` + `args[]` and we spawn with `shell: false`. If any
// future port needs a pipeline, it must split into two `run()` calls.
//
// Timeout and cwd are configurable. stdout/stderr are buffered and returned
// as strings; callers can stream if they need to by reaching for
// `child_process.spawn` directly.
import { spawn } from 'child_process';
import { currentProcessEnv } from '../config/env.js';

export interface RunOptions {
  /** Working directory for the child process. */
  cwd?: string;
  /** Extra env vars to merge on top of the current environment. */
  env?: NodeJS.ProcessEnv;
  /** Milliseconds before the child is killed with SIGKILL. Default 30s. */
  timeoutMs?: number;
  /** Max stdout+stderr bytes to buffer. Default 16 MiB. */
  maxBuffer?: number;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Spawn `cmd` with `args` and resolve once the child exits. Never uses a
 * shell interpreter — `shell: false` is enforced.
 *
 * Resolves with a `RunResult` even for non-zero exit codes; callers who want
 * a throw-on-failure behaviour should wrap with `runOrThrow` below.
 */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ? { ...currentProcessEnv(), ...opts.env } : undefined,
      shell: false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let bufLen = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      bufLen += chunk.length;
      if (bufLen > maxBuffer) { child.kill('SIGKILL'); return; }
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      bufLen += chunk.length;
      if (bufLen > maxBuffer) { child.kill('SIGKILL'); return; }
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, signal, timedOut });
    });
  });
}

/** Like `run` but rejects on non-zero exit / timeout / signal. */
export async function runOrThrow(
  cmd: string,
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  const r = await run(cmd, args, opts);
  if (r.timedOut) {
    throw new Error(`Command timed out: ${cmd} ${args.join(' ')}`);
  }
  if (r.code !== 0) {
    throw new Error(
      `Command failed (code=${r.code}, signal=${r.signal ?? 'none'}): ${cmd} ${args.join(' ')}\n${r.stderr}`,
    );
  }
  return r;
}
