// Minimal request logger with secret redaction.
//
// Format:   METHOD path status duration
//
// Never logs response bodies. Sensitive request headers (Authorization) are
// redacted in error cases where we echo back a subset of the request (we
// currently do not, but the redaction helper is exported so that future
// middleware can reuse it consistently).

import type { Request, Response, NextFunction, RequestHandler } from 'express';

const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'x-api-key']);
const SENSITIVE_BODY_FIELDS = new Set([
  'apikey', 'hftoken', 'token', 'password', 'secret',
]);

/** Return a shallow copy of `headers` with sensitive values replaced by `"[redacted]"`. */
export function redactHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? '[redacted]' : v;
  }
  return out;
}

/** Return a shallow copy of `body` with sensitive values replaced by `"[redacted]"`. */
export function redactBody(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    out[k] = SENSITIVE_BODY_FIELDS.has(k.toLowerCase()) ? '[redacted]' : v;
  }
  return out;
}

export function requestLogger(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - start;
      // eslint-disable-next-line no-console
      console.log(`${req.method} ${req.originalUrl || req.url} ${res.statusCode} ${ms}ms`);
    });
    next();
  };
}
