// Single log entry point for the server.
//
// Wraps `console.*` with a timestamped level-prefixed format so studio code
// and ported launcher code emit consistent output. `middleware/logging.ts`
// retains its own `console.log` for HTTP request lines (same format contract).
//
// Rules:
// - Outside this file and `middleware/logging.ts`, direct `console.*` is
//   banned; see the structure tests.
// - `debug` is only emitted when the LOG_LEVEL env permits it; read through
//   `env.LOG_LEVEL` so no direct env access lives here.
// - `ctx` objects are JSON-serialized verbatim; callers MUST redact secrets
//   (use `redactHeaders` / `redactBody` from `middleware/logging.ts` when
//   forwarding request fragments).
//
// This module is side-effect free at import time.
import { env } from '../config/env.js';

type Level = 'error' | 'warn' | 'info' | 'debug';

const ORDER: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };

function currentLevel(): Level {
  const raw = (env.LOG_LEVEL || 'info').toLowerCase();
  if (raw === 'error' || raw === 'warn' || raw === 'info' || raw === 'debug') return raw;
  return 'info';
}

function enabled(level: Level): boolean {
  return ORDER[level] <= ORDER[currentLevel()];
}

function timestamp(): string {
  return new Date().toISOString();
}

function format(level: Level, msg: string, ctx?: unknown): string {
  const head = `${timestamp()} [${level.toUpperCase()}] ${msg}`;
  if (ctx === undefined) return head;
  let tail: string;
  try {
    tail = typeof ctx === 'string' ? ctx : JSON.stringify(ctx);
  } catch {
    tail = '[unserializable ctx]';
  }
  return `${head} ${tail}`;
}

function emit(level: Level, msg: string, ctx?: unknown): void {
  if (!enabled(level)) return;
  const line = format(level, msg, ctx);
  // eslint-disable-next-line no-console
  if (level === 'error') console.error(line);
  // eslint-disable-next-line no-console
  else if (level === 'warn') console.warn(line);
  // eslint-disable-next-line no-console
  else console.log(line);
}

export const logger = {
  error(msg: string, ctx?: unknown): void { emit('error', msg, ctx); },
  warn(msg: string, ctx?: unknown): void { emit('warn', msg, ctx); },
  info(msg: string, ctx?: unknown): void { emit('info', msg, ctx); },
  debug(msg: string, ctx?: unknown): void { emit('debug', msg, ctx); },
};

export type Logger = typeof logger;
