// OpenAPI 3.1 document emitter.
//
// Walks `getRegisteredRoutes()` + the two hand-rolled SSE endpoints and
// produces a fully self-contained OpenAPI 3.1 document via
// @asteasolutions/zod-to-openapi.
//
// Design note on Zod module isolation:
//   Route schemas are created at module-load time by many different source
//   files. `extendZodWithOpenApi(z)` patches `z.ZodType.prototype.openapi`
//   on the Zod instance loaded by THIS file. In a Node ESM / tsx environment
//   the same physical `zod` package IS the same module instance (ESM caches
//   by resolved URL), so prototype-mutation propagates retroactively.
//
//   However `registry.register(name, schema)` calls `schema.openapi(name)`,
//   which requires the patch to already be applied. We call
//   `extendZodWithOpenApi(z)` at the top of this module (before any
//   `buildOpenApiDocument` call), which is fine as long as this module is
//   imported before the routes are imported OR the Zod instance is shared.
//
//   To be safe against any edge case we avoid calling `registry.register()`
//   for schemas created outside this file. Instead, inline schemas are
//   defined here (so extendZodWithOpenApi has already run) and the error
//   envelope is registered as a raw component object.

import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
  OpenApiGeneratorV31,
} from '@asteasolutions/zod-to-openapi';
import type { RouteConfig } from '@asteasolutions/zod-to-openapi';
import { getRegisteredRoutes } from '../defineRoute.js';
import { chatConvSseSpec } from '../../contracts/chat.contract.js';
import { buildSseUnionSchema } from './sseSchema.js';

// Patch the Zod prototype with .openapi() ONCE, as early as possible.
extendZodWithOpenApi(z);

function readServerVersion(): string {
  try {
    const __dir = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(__dir, '../../../package.json');
    const raw = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return raw.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Singleton document, built lazily and cached. */
let _doc: Record<string, unknown> | null = null;

export function clearOpenApiCache(): void {
  _doc = null;
}

// ---- Inline error schemas (created here so .openapi() is already patched) --

/** Inline PageMeta schema — used to wrap every route's `data` in `{data, meta?}`. */
const PageMetaInline = z.object({
  page: z.number().int().nonnegative().optional(),
  pageSize: z.number().int().positive().optional(),
  total: z.number().int().nonnegative().optional(),
  hasMore: z.boolean().optional(),
  nextCursor: z.string().optional(),
}).partial().optional();

// ---- Raw OpenAPI component for the error envelope --------------------------
// Defined as a plain JSON Schema object so we never need to call
// `.openapi()` on a schema that was created outside this file.
const apiErrorEnvelopeSchema = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: {
          type: 'string',
          enum: [
            'validation_failed', 'not_found', 'unauthorized', 'forbidden',
            'conflict', 'rate_limited', 'unsupported_media', 'payload_too_large',
            'upstream_unavailable', 'internal_error',
          ],
          description: 'Machine-readable error code',
        },
        message: { type: 'string', description: 'Human-readable error message' },
        details: { description: 'Optional structured error details' },
      },
    },
  },
} as const;

/** Build (or return cached) the OpenAPI 3.1 document. */
export function buildOpenApiDocument(): Record<string, unknown> {
  if (_doc) return _doc;

  const registry = new OpenAPIRegistry();

  // ---- Register the error envelope as a raw schema component -----------
  // Cast needed because registerComponent expects mutable arrays in SchemaObject,
  // but our inline literal uses readonly tuples (consistent with JSON Schema).
  registry.registerComponent(
    'schemas',
    'ApiErrorEnvelope',
    apiErrorEnvelopeSchema as unknown as Parameters<typeof registry.registerComponent>[2],
  );

  const errorRef = { $ref: '#/components/schemas/ApiErrorEnvelope' };

  const defaultErrorResponse = {
    description: 'Error envelope',
    content: { 'application/json': { schema: errorRef } },
  };

  // ---- Security scheme -------------------------------------------------
  registry.registerComponent('securitySchemes', 'apiKey', {
    type: 'http',
    scheme: 'bearer',
  });

  // ---- Register defineRoute routes ------------------------------------
  for (const { spec } of getRegisteredRoutes()) {
    const {
      method,
      path: routePath,
      params,
      query,
      body: bodySchema,
      response,
      auth,
      tags,
      summary,
      responseContentType,
    } = spec;

    const openapiPath = routePath.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');

    const security = buildSecurity(auth?.required ?? false, auth?.scopes);

    const request: RouteConfig['request'] = {};
    if (params) request.params = params as NonNullable<RouteConfig['request']>['params'];
    if (query) request.query = query as NonNullable<RouteConfig['request']>['query'];
    if (bodySchema) {
      request.body = {
        required: true,
        content: { 'application/json': { schema: bodySchema } },
      };
    }

    // Non-JSON routes (e.g. NDJSON streams) skip the envelope wrapper.
    const successContent = responseContentType
      ? { [responseContentType]: { schema: response } }
      : { 'application/json': { schema: z.object({ data: response, meta: PageMetaInline }) } };

    const routeConfig: RouteConfig = {
      method: method.toLowerCase() as RouteConfig['method'],
      path: openapiPath,
      summary,
      tags: tags ? [...tags] : undefined,
      security,
      request,
      responses: {
        200: {
          description: 'Success',
          content: successContent,
        },
        default: defaultErrorResponse,
      },
    };

    registry.registerPath(routeConfig);
  }

  // ---- Hand-rolled SSE endpoints --------------------------------------

  // GET /chat/conversations/:id/stream
  const chatSseSchema = buildSseUnionSchema(
    chatConvSseSpec as unknown as Parameters<typeof buildSseUnionSchema>[0],
  );
  registry.registerPath({
    method: 'get',
    path: '/chat/conversations/{id}/stream',
    summary: 'Per-conversation chat SSE stream',
    tags: ['chat'],
    security: [],
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description:
          'Server-Sent Events stream. Events: chunk | reasoning | tool | status | done (terminal) | error (terminal)',
        content: { 'text/event-stream': { schema: chatSseSchema } },
      },
      default: defaultErrorResponse,
    },
  });

  // GET /videoboard/jobs/:id/stream
  const jobSseSchema = buildSseUnionSchema({
    events: {
      progress: z.object({
        jobId: z.string(),
        status: z.enum(['queued', 'running', 'done', 'error']),
        progress: z.number().min(0).max(1),
        message: z.string().optional(),
      }),
      result: z.object({
        jobId: z.string(),
        status: z.literal('done'),
        progress: z.number(),
        outputUrl: z.string().optional(),
        message: z.string().optional(),
      }),
      error: z.object({
        jobId: z.string(),
        status: z.literal('error'),
        message: z.string(),
      }),
      done: z.object({ jobId: z.string() }),
    },
    terminalEvents: ['result', 'error', 'done'],
  });

  registry.registerPath({
    method: 'get',
    path: '/videoboard/jobs/{id}/stream',
    summary: 'Videoboard job SSE stream',
    tags: ['videoboard'],
    security: [{ apiKey: ['videoboard:read'] }],
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description:
          'Server-Sent Events stream. Events: progress | result (terminal) | error (terminal) | done (terminal)',
        content: { 'text/event-stream': { schema: jobSseSchema } },
      },
      default: defaultErrorResponse,
    },
  });

  // ---- Generate document ---------------------------------------------
  const generator = new OpenApiGeneratorV31(registry.definitions);
  const doc = generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'ComfyUI Studio API',
      description:
        'Every success response is wrapped as `{ data: T, meta?: PageMeta }`. ' +
        'Errors use `{ error: { code, message, details? } }` with a stable `code` string. ' +
        'Bearer auth is required on routes with `security: [{ apiKey: [...] }]`.',
      version: readServerVersion(),
    },
    servers: [{ url: '/api', description: 'Studio server' }],
  });

  _doc = doc as unknown as Record<string, unknown>;
  return _doc;
}

// ---- Helpers --------------------------------------------------------

type SecurityRequirement = Record<string, string[]>;

function buildSecurity(
  required: boolean,
  scopes: readonly string[] | undefined,
): SecurityRequirement[] | undefined {
  if (!required) return [];
  return [{ apiKey: scopes ? [...scopes] : [] }];
}
