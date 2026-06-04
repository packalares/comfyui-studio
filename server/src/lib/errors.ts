// Typed error classes mapped to the canonical envelope. Throw these from
// any handler / service; the `errorHandler` middleware (and `defineRoute`'s
// catch shim) translate them into `{ error: { code, message, details? } }`
// with the matching HTTP status.

import { errorStatus, type ErrorCode } from '../contracts/envelope.contract.js';

export interface HttpProblem {
  code: ErrorCode;
  message: string;
  status: number;
  details?: unknown;
}

export class HttpError extends Error implements HttpProblem {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.code = code;
    this.status = errorStatus[code];
    this.details = details;
  }
}

export class ValidationError extends HttpError {
  constructor(message = 'Validation failed', details?: unknown) {
    super('validation_failed', message, details);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends HttpError {
  constructor(message = 'Not found', details?: unknown) {
    super('not_found', message, details);
    this.name = 'NotFoundError';
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message = 'Unauthorized', details?: unknown) {
    super('unauthorized', message, details);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends HttpError {
  constructor(message = 'Forbidden', details?: unknown) {
    super('forbidden', message, details);
    this.name = 'ForbiddenError';
  }
}

export class ConflictError extends HttpError {
  constructor(message = 'Conflict', details?: unknown) {
    super('conflict', message, details);
    this.name = 'ConflictError';
  }
}

export class RateLimitError extends HttpError {
  constructor(message = 'Rate limited', details?: unknown) {
    super('rate_limited', message, details);
    this.name = 'RateLimitError';
  }
}

export class UpstreamUnavailableError extends HttpError {
  constructor(message = 'Upstream service unavailable', details?: unknown) {
    super('upstream_unavailable', message, details);
    this.name = 'UpstreamUnavailableError';
  }
}

export function isHttpError(err: unknown): err is HttpError {
  return err instanceof HttpError;
}
