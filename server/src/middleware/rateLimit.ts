// In-memory rate limiter — single-process / per-pod. Not cluster-safe.
//
// Central config: every limit lives in `RATE_LIMIT_PROFILES`. Route files
// reference a named profile (`rateLimit('plugins:write')`); they no longer
// inline windowMs/max.
//
// Trusted-UI bypass: requests whose authMiddleware already classified as
// `actor.type === 'ui'` (master-key cookie + same-origin) are NEVER counted.
// Only external Bearer-key callers ever burn buckets.
//
// Response on overflow:
//   HTTP 429 { error: { code: 'rate_limited', ... } }
//   Retry-After header set to the window remainder in seconds.

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { RateLimitError } from '../lib/errors.js';

interface Bucket { count: number; resetAt: number }

export interface RateLimitOpts {
  windowMs: number;
  max: number;
}

// One name → one profile. Keep this list as the single source of truth.
// Route files use rateLimit('name'); no inline numbers anywhere else.
//
// 'default' is the global baseline applied to every /api/* request (see
// applyGlobalRateLimit() in index.ts). Named profiles below override the
// default ONLY when they are TIGHTER — Express runs middleware in order
// and both buckets fill, so the effective cap is the strictest of the two.
// If a profile is looser than 'default', the default still bites first;
// we keep them aligned so this doesn't surprise anyone.
export const RATE_LIMIT_PROFILES = {
  // Global baseline for every /api/* call — only Bearer-key traffic.
  'default':                 { windowMs: 60_000, max: 300 },

  // Tighter overrides for write/import paths most likely to be abused.
  'templates:import:civitai':{ windowMs: 60_000, max: 100 },
  'templates:import:github': { windowMs: 60_000, max: 100 },
  'plugins:write':           { windowMs: 60_000, max: 100 },
  'python:pkg':              { windowMs: 60_000, max: 100 },
  'network:config':          { windowMs: 60_000, max: 100 },
  'civitai:by-url':          { windowMs: 60_000, max: 300 },
  'models:download-custom':  { windowMs: 60_000, max: 300 },
  'templates:import:paste':  { windowMs: 60_000, max: 300 },

  // Generative paths — high cap to allow interactive bursts.
  'upload':                  { windowMs: 60_000, max: 600 },
  'generate':                { windowMs: 60_000, max: 600 },
} as const;

export type RateLimitProfile = keyof typeof RATE_LIMIT_PROFILES;

function clientKey(req: Request): string {
  return (req.ip || req.socket.remoteAddress || 'unknown');
}

// Probabilistic sweep keeps the bucket map bounded without paying O(n) per call.
const SWEEP_PROB = 0.001;

function sweepStale(buckets: Map<string, Bucket>, now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt < now) buckets.delete(key);
  }
}

/**
 * Build a rate-limiter from a named profile (preferred) or raw opts
 * (for tests + ad-hoc use). Trusted-UI requests (actor.type === 'ui')
 * bypass entirely; only external Bearer-key callers consume buckets.
 */
export function rateLimit(input: RateLimitProfile | RateLimitOpts): RequestHandler {
  const opts: RateLimitOpts = typeof input === 'string'
    ? RATE_LIMIT_PROFILES[input]
    : input;
  const buckets = new Map<string, Bucket>();
  return (req: Request, res: Response, next: NextFunction) => {
    // Same-origin browser UI authenticated via master cookie → never throttled.
    // Only external API-key clients hit the bucket.
    if (req.actor?.type === 'ui') { next(); return; }

    const now = Date.now();
    const key = clientKey(req);
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (Math.random() < SWEEP_PROB) sweepStale(buckets, now);
    if (bucket.count > opts.max) {
      const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      next(new RateLimitError('Rate limit exceeded'));
      return;
    }
    next();
  };
}
