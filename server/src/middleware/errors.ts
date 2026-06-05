// Express error middleware + async handler wrapper.
//
// Thrown errors are translated to the canonical envelope:
//
//   { error: { code: ErrorCode, message: string, details?: unknown } }
//
// `HttpError` subclasses carry their own `code` + status. `ZodError` becomes
// `validation_failed` (400). Anything else is `internal_error` (500). In
// production, stack traces and raw error payloads are stripped from `details`.
//
// 401 (`unauthorized`) and 403 (`forbidden`) never carry `details` regardless
// of environment — the absence/presence of resources and identity hints must
// not leak via error bodies.

import type { Request, Response, NextFunction, RequestHandler, ErrorRequestHandler } from 'express';
import { z } from 'zod';
import { isProduction } from '../config/env.js';
import { errorStatus, type ErrorCode, type ApiErrorEnvelope } from '../contracts/envelope.contract.js';
import { HttpError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

function makeBody(code: ErrorCode, message: string, details: unknown): ApiErrorEnvelope {
  const body: ApiErrorEnvelope = { error: { code, message } };
  // 401/403: empty details + generic message at the boundary. Internal
  // messages still log; only the wire response is sanitised.
  if (code === 'unauthorized' || code === 'forbidden') return body;
  if (details !== undefined) body.error.details = details;
  return body;
}

function fromHttpError(err: HttpError): { status: number; body: ApiErrorEnvelope } {
  const message = (err.code === 'unauthorized' || err.code === 'forbidden')
    ? (err.code === 'unauthorized' ? 'Unauthorized' : 'Forbidden')
    : err.message;
  return {
    status: errorStatus[err.code],
    body: makeBody(err.code, message, err.details),
  };
}

function fromZodError(err: z.ZodError): { status: number; body: ApiErrorEnvelope } {
  const details = err.issues.map((i) => ({
    path: i.path.join('.'),
    message: i.message,
    code: i.code,
  }));
  return {
    status: errorStatus.validation_failed,
    body: makeBody('validation_failed', 'Validation failed', details),
  };
}

function fromUnknown(err: unknown): { status: number; body: ApiErrorEnvelope } {
  const details = isProduction()
    ? undefined
    : (err instanceof Error ? { message: err.message, stack: err.stack } : String(err));
  return {
    status: errorStatus.internal_error,
    body: makeBody('internal_error', 'Internal error', details),
  };
}

export function errorHandler(): ErrorRequestHandler {
  return (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    let resolved: { status: number; body: ApiErrorEnvelope };
    if (err instanceof HttpError) resolved = fromHttpError(err);
    else if (err instanceof z.ZodError) resolved = fromZodError(err);
    else resolved = fromUnknown(err);
    if (resolved.status >= 500) {
      logger.error('errorHandler: 5xx', {
        code: resolved.body.error.code,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    res.status(resolved.status).json(resolved.body);
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
