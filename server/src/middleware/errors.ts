// Express error middleware + async handler wrapper.
//
// All 5xx errors flow through here so responses have a consistent shape:
//
//   { error: string, code?: string, detail?: string }
//
// Stack traces are surfaced as `detail` ONLY outside production.

import type { Request, Response, NextFunction, RequestHandler, ErrorRequestHandler } from 'express';
import { isProduction } from '../config/env.js';

/**
 * Emit an error JSON response that respects production redaction. Callers pass
 * in the user-visible `error` message plus the raw `err` value (only included
 * as `detail` outside production). Use this in every route-level `catch` so
 * stacks/internal strings never leak in prod.
 */
export function sendError(
  res: Response,
  err: unknown,
  status: number,
  message: string,
): void {
  const body: { error: string; detail?: string } = { error: message };
  if (!isProduction()) body.detail = String(err);
  if (!res.headersSent) res.status(status).json(body);
}

interface ApiErrorShape {
  status?: number;
  code?: string;
  message?: string;
  detail?: string;
}

export class ApiError extends Error {
  status: number;
  code?: string;
  detail?: string;
  constructor(status: number, message: string, opts: { code?: string; detail?: string } = {}) {
    super(message);
    this.status = status;
    this.code = opts.code;
    this.detail = opts.detail;
  }
}

function statusFrom(err: unknown): number {
  if (err && typeof err === 'object' && 'status' in err) {
    const s = (err as ApiErrorShape).status;
    if (typeof s === 'number' && s >= 400 && s <= 599) return s;
  }
  return 500;
}

function messageFrom(err: unknown): string {
  if (err instanceof Error) return err.message || 'Internal error';
  if (typeof err === 'string') return err;
  return 'Internal error';
}

export function errorHandler(): ErrorRequestHandler {
  return (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = statusFrom(err);
    const body: { error: string; code?: string; detail?: string } = {
      error: messageFrom(err),
    };
    if (err && typeof err === 'object' && 'code' in err) {
      const c = (err as ApiErrorShape).code;
      if (typeof c === 'string') body.code = c;
    }
    if (!isProduction()) {
      const detail = err && typeof err === 'object' && 'detail' in err
        ? (err as ApiErrorShape).detail
        : (err instanceof Error ? err.stack : undefined);
      if (typeof detail === 'string' && detail.length > 0) body.detail = detail;
    }
    if (!res.headersSent) res.status(status).json(body);
  };
}

/** Wraps an async route handler so thrown errors propagate to `errorHandler`. */
export function asyncHandler<P = unknown>(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<P>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
