// Tests for sendError helper — confirms production mode strips `detail` so
// route-level catch blocks never leak stack/internal strings to clients.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';

interface CapturedResponse {
  status: (code: number) => CapturedResponse;
  json: (body: unknown) => CapturedResponse;
  headersSent: boolean;
  statusCode?: number;
  body?: unknown;
}

function makeRes(): CapturedResponse {
  const res: CapturedResponse = {
    headersSent: false,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(body) {
      res.body = body;
      return res;
    },
  };
  return res;
}

describe('sendError', () => {
  const origNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (origNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = origNodeEnv;
  });

  it('includes detail in non-production mode', async () => {
    process.env.NODE_ENV = 'development';
    const { sendError } = await import('../../src/middleware/errors.js');
    const res = makeRes();
    sendError(res as unknown as Response, new Error('boom'), 500, 'oops');
    expect(res.statusCode).toBe(500);
    const body = res.body as { error: string; detail?: string };
    expect(body.error).toBe('oops');
    expect(body.detail).toContain('boom');
  });

  it('strips detail in production mode', async () => {
    process.env.NODE_ENV = 'production';
    const { sendError } = await import('../../src/middleware/errors.js');
    const res = makeRes();
    sendError(res as unknown as Response, new Error('internal path /etc/passwd'), 502, 'upstream unavailable');
    expect(res.statusCode).toBe(502);
    const body = res.body as { error: string; detail?: string };
    expect(body.error).toBe('upstream unavailable');
    expect(body.detail).toBeUndefined();
    // Double-check the internal string never made it onto the body at all.
    expect(JSON.stringify(body)).not.toContain('/etc/passwd');
  });

  it('no-ops when headers already sent', async () => {
    process.env.NODE_ENV = 'development';
    const { sendError } = await import('../../src/middleware/errors.js');
    const res = makeRes();
    res.headersSent = true;
    sendError(res as unknown as Response, new Error('late'), 500, 'late failure');
    expect(res.statusCode).toBeUndefined();
    expect(res.body).toBeUndefined();
  });
});
