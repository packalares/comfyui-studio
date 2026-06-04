// Canonical API response envelope used by every `defineRoute` handler.
//
// Two shapes only:
//   { data: T, meta?: PageMeta }    — success
//   { error: { code, message, details? } } — failure
//
// `code` is a stable machine-readable string. UI matches on `code`, never on
// `message`. Add new codes to `ErrorCode` so the union stays exhaustive.

import { z } from 'zod';

export const errorCodes = [
  'validation_failed',
  'not_found',
  'unauthorized',
  'forbidden',
  'conflict',
  'rate_limited',
  'unsupported_media',
  'payload_too_large',
  'upstream_unavailable',
  'internal_error',
] as const;

export const ErrorCodeSchema = z.enum(errorCodes);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const PageMetaSchema = z.object({
  page: z.number().int().nonnegative().optional(),
  pageSize: z.number().int().positive().optional(),
  total: z.number().int().nonnegative().optional(),
  hasMore: z.boolean().optional(),
  nextCursor: z.string().optional(),
}).partial();
export type PageMeta = z.infer<typeof PageMetaSchema>;

export const ApiErrorBodySchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  details: z.unknown().optional(),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;

export const ApiErrorSchema = z.object({ error: ApiErrorBodySchema });
export type ApiErrorEnvelope = z.infer<typeof ApiErrorSchema>;

// Success envelope generic — `data` is parameterised per route via z.infer on
// the concrete schema. Phase E (OpenAPI emit) reads the route's `response`
// spec and substitutes the concrete schema here.
export function successEnvelopeSchema<T extends z.ZodTypeAny>(data: T) {
  return z.object({
    data,
    meta: PageMetaSchema.optional(),
  });
}

export interface ApiSuccess<T> {
  data: T;
  meta?: PageMeta;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiErrorEnvelope;

// HTTP status mapping. Single source of truth so middleware + defineRoute
// agree on what each code maps to.
export const errorStatus: Record<ErrorCode, number> = {
  validation_failed: 400,
  not_found: 404,
  unauthorized: 401,
  forbidden: 403,
  conflict: 409,
  rate_limited: 429,
  unsupported_media: 415,
  payload_too_large: 413,
  upstream_unavailable: 502,
  internal_error: 500,
};
