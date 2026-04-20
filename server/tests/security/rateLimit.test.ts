// Tests for the in-memory rate limiter middleware.

import { describe, expect, it } from 'vitest';
import { rateLimit } from '../../src/middleware/rateLimit.js';
import type { Request, Response, NextFunction } from 'express';

interface CapturedResponse {
  status: number | null;
  body: unknown;
  headers: Record<string, string>;
}

function makeReq(ip: string): Request {
  return { ip, socket: { remoteAddress: ip } } as unknown as Request;
}

function makeRes(captured: CapturedResponse): Response {
  return {
    status(code: number) { captured.status = code; return this; },
    json(body: unknown) { captured.body = body; return this; },
    setHeader(k: string, v: string) { captured.headers[k] = v; },
  } as unknown as Response;
}

describe('rateLimit', () => {
  it('allows requests under the cap', () => {
    const limiter = rateLimit({ windowMs: 60_000, max: 3 });
    let called = 0;
    const next: NextFunction = () => { called += 1; };
    for (let i = 0; i < 3; i++) {
      limiter(makeReq('1.1.1.1'), makeRes({ status: null, body: null, headers: {} }), next);
    }
    expect(called).toBe(3);
  });

  it('rejects the 4th request with 429 when max=3', () => {
    const limiter = rateLimit({ windowMs: 60_000, max: 3 });
    const next: NextFunction = () => { /* accepted */ };
    for (let i = 0; i < 3; i++) {
      limiter(makeReq('2.2.2.2'), makeRes({ status: null, body: null, headers: {} }), next);
    }
    const captured: CapturedResponse = { status: null, body: null, headers: {} };
    limiter(makeReq('2.2.2.2'), makeRes(captured), next);
    expect(captured.status).toBe(429);
    expect(captured.body).toMatchObject({ error: 'rate_limit' });
    expect(captured.headers['Retry-After']).toBeDefined();
  });

  it('buckets per IP independently', () => {
    const limiter = rateLimit({ windowMs: 60_000, max: 1 });
    let accepted = 0;
    const next: NextFunction = () => { accepted += 1; };
    limiter(makeReq('3.3.3.3'), makeRes({ status: null, body: null, headers: {} }), next);
    limiter(makeReq('4.4.4.4'), makeRes({ status: null, body: null, headers: {} }), next);
    // Each IP got its first request through.
    expect(accepted).toBe(2);
  });
});
