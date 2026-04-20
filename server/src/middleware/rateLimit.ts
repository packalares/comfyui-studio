// Tiny fixed-window in-memory rate limiter.
//
// Deliberately simple: single Map<string, { count, resetAt }> per limiter.
// Not cluster-safe — for pod-internal single-process use this is enough. If
// the server is ever horizontally scaled, swap for a shared-memory impl.
//
// Response on overflow:
//   HTTP 429 { error: 'rate_limit', detail: 'retry later' }
//   Retry-After header set to the window remainder in seconds.

import type { Request, Response, NextFunction, RequestHandler } from 'express';

interface Bucket { count: number; resetAt: number }

export interface RateLimitOpts {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Max requests per key per window. */
  max: number;
}

function clientKey(req: Request): string {
  // Fall back to a constant if ip is missing so we still rate-limit the
  // anonymous bucket rather than letting every such request through.
  return (req.ip || req.socket.remoteAddress || 'unknown');
}

export function rateLimit(opts: RateLimitOpts): RequestHandler {
  const buckets = new Map<string, Bucket>();
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = clientKey(req);
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > opts.max) {
      const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      res.status(429).json({ error: 'rate_limit', detail: 'retry later' });
      return;
    }
    next();
  };
}
