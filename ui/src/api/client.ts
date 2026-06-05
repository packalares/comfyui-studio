// Typed UI client for the Studio API.
//
// `apiCall(spec, input)` reads the route spec (URL, method, Zod schemas),
// builds the request, validates the canonical success/error envelope, unwraps
// `data`, and returns it. Errors arrive as typed `ApiClientError` with a
// machine-readable `code` matching `ErrorCode`. Same-origin UI traffic carries
// no auth header; external consumers wrap via `createApiClient({ apiKey })`.

import { z } from 'zod';
import type { RouteSpec } from '@server/lib/defineRoute';
import {
  ApiErrorSchema,
  errorStatus,
  PageMetaSchema,
  successEnvelopeSchema,
  type ErrorCode,
  type PageMeta,
} from '@server/contracts/envelope.contract';
import { ApiClientError } from './error.js';

// Type-level: which fields a given spec declares. The defaults on `RouteSpec`
// make all four schema generics extend `z.ZodTypeAny`, so we cannot key off the
// generic itself — we key off whether the property is present on the structural
// type of the literal spec passed in. A spec without `params` simply has no
// `params` key, so `'params' extends keyof S` is `false` and the input type
// drops that field.
type SchemaField<S, K extends 'params' | 'query' | 'body'> =
  K extends keyof S ? S[K] : undefined;

type FieldInput<F> = F extends z.ZodTypeAny ? z.infer<F> : never;

export type ApiCallInput<S> =
  (SchemaField<S, 'params'> extends z.ZodTypeAny
    ? { params: FieldInput<SchemaField<S, 'params'>> }
    : Record<never, never>)
  & (SchemaField<S, 'query'> extends z.ZodTypeAny
    ? { query: FieldInput<SchemaField<S, 'query'>> }
    : Record<never, never>)
  & (SchemaField<S, 'body'> extends z.ZodTypeAny
    ? { body: FieldInput<SchemaField<S, 'body'>> }
    : Record<never, never>)
  & { signal?: AbortSignal };

export type ApiCallOutput<S> = S extends { response: infer R }
  ? R extends z.ZodTypeAny
    ? z.infer<R>
    : never
  : never;

export interface ApiCallPaginatedOutput<S> {
  items: ApiCallOutput<S>;
  meta: PageMeta;
}

export interface ApiClientConfig {
  /** Bearer API key. Omit for same-origin UI use — the server treats the local
   *  cookie/dev context as authoritative; an explicit header is only needed
   *  for external consumers. */
  apiKey?: string;
  /** Override the URL prefix the routes mount under. Defaults to `/api`. */
  baseUrl?: string;
  /** Custom `fetch` impl, mainly for tests. */
  fetch?: typeof fetch;
}

const DEFAULT_BASE_URL = '/api';

function interpolatePath(template: string, params: Record<string, unknown> | undefined): string {
  if (!params) return template;
  // Replace each `:name` segment with the URL-encoded param value. We only
  // touch identifier-shaped placeholders so the rest of the path passes through
  // untouched (catches `:not-a-name`-style regex segments as no-ops).
  return template.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (match, key: string) => {
    if (!(key in params)) {
      throw new Error(`apiCall: missing path param "${key}" for "${template}"`);
    }
    return encodeURIComponent(String(params[key]));
  });
}

function buildQueryString(query: Record<string, unknown> | undefined): string {
  if (!query) return '';
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const v of value) usp.append(key, String(v));
      continue;
    }
    usp.append(key, String(value));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

function bodyAllowedFor(method: string): boolean {
  const m = method.toUpperCase();
  return m !== 'GET' && m !== 'HEAD';
}

// Treat anything `fetch` can throw natively (network failure, abort) as an
// upstream error rather than a server-shaped envelope. AbortError surfaces with
// the same `code` shape so callers can branch uniformly.
function toClientError(err: unknown): ApiClientError {
  if (err instanceof ApiClientError) return err;
  if (err instanceof DOMException && err.name === 'AbortError') {
    return new ApiClientError({
      code: 'upstream_unavailable',
      status: 0,
      message: 'Request aborted',
    });
  }
  const message = err instanceof Error ? err.message : 'Network request failed';
  return new ApiClientError({
    code: 'upstream_unavailable',
    status: 0,
    message,
  });
}

interface PreparedRequest {
  url: string;
  init: RequestInit;
}

function prepareRequest<S extends RouteSpec>(
  spec: S,
  input: ApiCallInput<S>,
  config: ApiClientConfig,
): PreparedRequest {
  // We index `input` as a loose record here — the public surface is generic
  // and type-checked at the call site, so the runtime view is free to be
  // structural.
  const raw = input as Record<string, unknown> & { signal?: AbortSignal };
  const params = raw.params as Record<string, unknown> | undefined;
  const query = raw.query as Record<string, unknown> | undefined;
  const body = raw.body;

  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const path = interpolatePath(spec.path, params);
  const url = `${baseUrl}${path}${buildQueryString(query)}`;

  const headers: Record<string, string> = { Accept: 'application/json' };
  const init: RequestInit = { method: spec.method, headers };

  if (bodyAllowedFor(spec.method) && body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  if (raw.signal) init.signal = raw.signal;

  return { url, init };
}

interface ParsedEnvelope<T> {
  data: T;
  meta?: PageMeta;
}

async function parseEnvelope<S extends RouteSpec>(
  spec: S,
  res: Response,
): Promise<ParsedEnvelope<ApiCallOutput<S>>> {
  let rawBody: unknown = null;
  try {
    rawBody = await res.json();
  } catch {
    // Empty/non-JSON body on a non-2xx: synthesise an envelope from the status.
    if (!res.ok) {
      throw new ApiClientError({
        code: 'upstream_unavailable',
        status: res.status,
        message: `${res.status} ${res.statusText || 'no body'}`,
      });
    }
    throw new ApiClientError({
      code: 'internal_error',
      status: res.status,
      message: 'Response body was not valid JSON',
    });
  }

  // Error envelope first — the wire shape is shared across every status.
  const errParsed = ApiErrorSchema.safeParse(rawBody);
  if (errParsed.success) {
    const e = errParsed.data.error;
    const expectedStatus = errorStatus[e.code];
    throw new ApiClientError({
      code: e.code,
      // Trust the wire status if it matches the code's canonical mapping;
      // otherwise fall back to the actual HTTP status so middleware-injected
      // errors (rate limit, auth) still carry the response status.
      status: res.status === expectedStatus ? res.status : res.status,
      message: e.message,
      details: e.details,
    });
  }

  if (!res.ok) {
    // Non-2xx with a body that didn't validate as our error envelope — the
    // request hit something outside the typed surface (proxy, raw express
    // error). Surface as upstream_unavailable with the raw body as details.
    throw new ApiClientError({
      code: 'upstream_unavailable',
      status: res.status,
      message: `${res.status} ${res.statusText || 'unexpected response'}`,
      details: rawBody,
    });
  }

  const successSchema = successEnvelopeSchema(spec.response);
  const parsed = successSchema.safeParse(rawBody);
  if (!parsed.success) {
    throw new ApiClientError({
      code: 'internal_error',
      status: res.status,
      message: 'Response envelope failed schema validation',
      details: parsed.error.issues,
    });
  }
  const env: ParsedEnvelope<ApiCallOutput<S>> = {
    data: parsed.data.data as ApiCallOutput<S>,
  };
  if (parsed.data.meta !== undefined) {
    const metaParsed = PageMetaSchema.safeParse(parsed.data.meta);
    if (metaParsed.success) env.meta = metaParsed.data;
  }
  return env;
}

async function runRequest<S extends RouteSpec>(
  spec: S,
  input: ApiCallInput<S>,
  config: ApiClientConfig,
): Promise<ParsedEnvelope<ApiCallOutput<S>>> {
  const { url, init } = prepareRequest(spec, input, config);
  const doFetch = config.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, init);
  } catch (err) {
    throw toClientError(err);
  }
  return parseEnvelope(spec, res);
}

export async function apiCall<S extends RouteSpec>(
  spec: S,
  input: ApiCallInput<S>,
): Promise<ApiCallOutput<S>> {
  const env = await runRequest(spec, input, {});
  return env.data;
}

export async function apiCallPaginated<S extends RouteSpec>(
  spec: S,
  input: ApiCallInput<S>,
): Promise<ApiCallPaginatedOutput<S>> {
  const env = await runRequest(spec, input, {});
  return { items: env.data, meta: env.meta ?? {} };
}

export interface ApiClient {
  call: <S extends RouteSpec>(spec: S, input: ApiCallInput<S>) => Promise<ApiCallOutput<S>>;
  callPaginated: <S extends RouteSpec>(spec: S, input: ApiCallInput<S>) => Promise<ApiCallPaginatedOutput<S>>;
  /** Re-exposed from `./sse` so external consumers get the same bound config
   *  for streaming endpoints. The function reference is set by the sse module
   *  on import to avoid a circular dependency. */
  openStream: never;
}

// We split the factory: `createApiClient` returns a config-bound version of
// `apiCall` / `apiCallPaginated`. The SSE stream opener composes the same
// config via `openSseStream`'s third argument — see `./sse`.
export function createApiClient(config: ApiClientConfig): {
  call: <S extends RouteSpec>(spec: S, input: ApiCallInput<S>) => Promise<ApiCallOutput<S>>;
  callPaginated: <S extends RouteSpec>(spec: S, input: ApiCallInput<S>) => Promise<ApiCallPaginatedOutput<S>>;
  config: Readonly<ApiClientConfig>;
} {
  const frozen = Object.freeze({ ...config });
  return {
    config: frozen,
    async call(spec, input) {
      const env = await runRequest(spec, input, frozen);
      return env.data;
    },
    async callPaginated(spec, input) {
      const env = await runRequest(spec, input, frozen);
      return { items: env.data, meta: env.meta ?? {} };
    },
  };
}

// Re-exported so `./sse` can compose URL + auth header off the same config
// path without re-implementing it. Not part of the public surface — consumers
// reach for `openSseStream` directly.
export const __internal = {
  prepareRequest,
  toClientError,
  DEFAULT_BASE_URL,
};
