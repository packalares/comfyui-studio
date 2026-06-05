// Type-safe route helper. Routes declared via `defineRoute` get:
//   - Zod-validated params/query/body, surfaced as 400 `validation_failed`.
//   - Auto-enveloped success bodies: `{ data, meta? }`.
//   - Thrown `HttpError` subclasses translated to the canonical error shape.
//   - Per-route metadata stored in `routeRegistry` for the OpenAPI emitter
//     and the auth middleware (wave 2) to walk.
//
// Auth contract: a route MUST declare `auth`. Omission is treated as "auth
// designer hasn't decided yet" — we register, run, and log a one-line warning
// at boot so wave 2 can audit the gap before flipping the default. Once wave 2
// sets the real default, the warning emitter is removed.

import type { Request, Response, NextFunction, Router } from 'express';
import { z } from 'zod';
import {
  errorStatus,
  type ErrorCode,
  type PageMeta,
  type ApiErrorEnvelope,
} from '../contracts/envelope.contract.js';
import { HttpError } from './errors.js';
import { logger } from './logger.js';
import { isProduction } from '../config/env.js';
import { authMiddleware } from '../middleware/auth.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface AuthSpec {
  required: boolean;
  scopes?: readonly string[] | string[];
}

export interface RouteSpec<
  P extends z.ZodTypeAny = z.ZodTypeAny,
  Q extends z.ZodTypeAny = z.ZodTypeAny,
  B extends z.ZodTypeAny = z.ZodTypeAny,
  R extends z.ZodTypeAny = z.ZodTypeAny,
> {
  method: HttpMethod;
  path: string;
  params?: P;
  query?: Q;
  body?: B;
  response: R;
  auth?: AuthSpec;
  tags?: readonly string[];
  summary?: string;
  /**
   * Override the success response content-type and skip the `{ data, meta? }`
   * envelope. Used by spec-only routes that stream raw bytes (e.g. NDJSON).
   * Defaults to `application/json` with envelope wrapping.
   */
  responseContentType?: string;
}

export interface RouteContext<P, Q, B> {
  params: P;
  query: Q;
  body: B;
  req: Request;
  res: Response;
  /** Build a successful envelope payload — the route returns this object. */
  ok: <T>(data: T, meta?: PageMeta) => { data: T; meta?: PageMeta };
}

export type RouteHandler<P, Q, B, R> = (
  ctx: RouteContext<P, Q, B>,
) => Promise<{ data: R; meta?: PageMeta }> | { data: R; meta?: PageMeta };

export interface RegisteredRoute {
  spec: RouteSpec;
  /** Mount this route onto the given Express router. */
  register: (router: Router) => void;
}

// Module-level registry. The OpenAPI emitter (wave 4) walks this to produce
// the spec; the auth audit logger walks it at boot to surface gaps.
const REGISTRY: RegisteredRoute[] = [];

export function getRegisteredRoutes(): readonly RegisteredRoute[] {
  return REGISTRY;
}

/**
 * Register spec-only metadata for routes that handle their own request/response
 * pipeline (e.g., raw streaming) and cannot use `defineRoute`. The spec appears
 * in the OpenAPI document; runtime auth gating is the caller's responsibility.
 */
export function registerSpecOnly(spec: RouteSpec): void {
  REGISTRY.push({
    spec,
    register() {
      // No-op: the real route is registered elsewhere (e.g., raw Express router).
    },
  });
}

/**
 * Emit a one-line warning per registered route that lacks an explicit `auth`
 * declaration. Called from boot once routes are loaded so wave 2 sees the
 * exact surface still pending an auth decision.
 */
export function warnRoutesMissingAuth(): void {
  for (const r of REGISTRY) {
    if (r.spec.auth === undefined) {
      logger.warn(
        `defineRoute: ${r.spec.method} ${r.spec.path} has no auth spec — wave 2 must decide`,
      );
    }
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function sendError(
  res: Response,
  code: ErrorCode,
  message: string,
  details?: unknown,
): void {
  const body: ApiErrorEnvelope = { error: { code, message } };
  // 401/403 never leak details — keep messages generic so absence/presence
  // of resources and identity hints don't escape.
  if (code !== 'unauthorized' && code !== 'forbidden' && details !== undefined) {
    body.error.details = details;
  }
  if (!res.headersSent) res.status(errorStatus[code]).json(body);
}

function formatZodIssues(err: z.ZodError): unknown {
  return err.issues.map((i) => ({
    path: i.path.join('.'),
    message: i.message,
    code: i.code,
  }));
}

function safeParse<T extends z.ZodTypeAny>(
  schema: T | undefined,
  value: unknown,
): { ok: true; value: z.infer<T> } | { ok: false; error: z.ZodError } {
  if (!schema) return { ok: true, value: value as z.infer<T> };
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, error: result.error };
}

function isObjectError(err: unknown): err is { message?: unknown; stack?: unknown } {
  return typeof err === 'object' && err !== null;
}

function buildInternalDetails(err: unknown): unknown {
  if (isProduction()) return undefined;
  if (err instanceof Error) return { message: err.message, stack: err.stack };
  if (isObjectError(err)) return err;
  return String(err);
}

export function defineRoute<
  P extends z.ZodTypeAny = z.ZodTypeAny,
  Q extends z.ZodTypeAny = z.ZodTypeAny,
  B extends z.ZodTypeAny = z.ZodTypeAny,
  R extends z.ZodTypeAny = z.ZodTypeAny,
>(
  spec: RouteSpec<P, Q, B, R>,
  handler: RouteHandler<z.infer<P>, z.infer<Q>, z.infer<B>, z.infer<R>>,
): RegisteredRoute {
  const ok = <T>(data: T, meta?: PageMeta): { data: T; meta?: PageMeta } => {
    return meta === undefined ? { data } : { data, meta };
  };

  const requestHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const paramsParsed = safeParse(spec.params, req.params);
      if (!paramsParsed.ok) {
        return sendError(res, 'validation_failed', 'Invalid path parameters', formatZodIssues(paramsParsed.error));
      }
      const queryParsed = safeParse(spec.query, req.query);
      if (!queryParsed.ok) {
        return sendError(res, 'validation_failed', 'Invalid query parameters', formatZodIssues(queryParsed.error));
      }
      const bodyRaw: unknown = isPlainObject(req.body) || Array.isArray(req.body) ? req.body : {};
      const bodyParsed = safeParse(spec.body, bodyRaw);
      if (!bodyParsed.ok) {
        return sendError(res, 'validation_failed', 'Invalid request body', formatZodIssues(bodyParsed.error));
      }

      const ctx: RouteContext<z.infer<P>, z.infer<Q>, z.infer<B>> = {
        params: paramsParsed.value as z.infer<P>,
        query: queryParsed.value as z.infer<Q>,
        body: bodyParsed.value as z.infer<B>,
        req,
        res,
        ok,
      };

      const result = await handler(ctx);
      if (res.headersSent) return;
      const payload = result.meta === undefined ? { data: result.data } : { data: result.data, meta: result.meta };
      res.status(200).json(payload);
    } catch (err) {
      if (err instanceof HttpError) {
        return sendError(res, err.code, err.message, err.details);
      }
      if (err instanceof z.ZodError) {
        return sendError(res, 'validation_failed', 'Validation failed', formatZodIssues(err));
      }
      logger.error(`route ${spec.method} ${spec.path} threw`, {
        error: err instanceof Error ? err.message : String(err),
      });
      sendError(res, 'internal_error', 'Internal error', buildInternalDetails(err));
      // Forward to the Express error handler for centralised logging too;
      // `sendError` already responded so it's a no-op past headers.
      next(err);
    }
  };

  const registered: RegisteredRoute = {
    spec,
    register(router: Router) {
      const method = spec.method.toLowerCase() as Lowercase<HttpMethod>;
      if (spec.auth?.required) {
        router[method](spec.path, authMiddleware(spec.auth), requestHandler);
      } else {
        router[method](spec.path, requestHandler);
      }
    },
  };
  REGISTRY.push(registered);
  return registered;
}
