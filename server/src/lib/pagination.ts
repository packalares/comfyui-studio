// Pagination helpers shared by list endpoints.
//
// `parsePageQuery` looks at ?page= and ?pageSize= on the request, clamps them
// to safe bounds, and returns `{ page, pageSize, isPaginated }`. `isPaginated`
// is false when the caller didn't send a `page` param — routes use that to
// preserve the legacy (un-wrapped) response shape for back-compat callers.
//
// `paginate` slices an in-memory array and returns the standard envelope.
//
// `splitPaginated` converts a `PageEnvelope<T>` (items + flat meta) into the
// `{ items, meta }` shape `defineRoute` handlers return via `ctx.ok(...)`.
// The meta shape matches `PageMeta` from `envelope.contract.ts`.

import type { Request } from 'express';
import type { PageMeta } from '../contracts/envelope.contract.js';

export interface PageQuery {
  page: number;
  pageSize: number;
  isPaginated: boolean;
}

export interface PageDefaults {
  defaultPageSize: number;
  maxPageSize: number;
}

export interface PageEnvelope<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

export function parsePageQuery(req: Request, defaults: PageDefaults): PageQuery {
  const hasPage = req.query.page !== undefined && req.query.page !== '';
  const page = clampInt(req.query.page, 1, Number.MAX_SAFE_INTEGER, 1);
  const pageSize = clampInt(
    req.query.pageSize,
    1,
    defaults.maxPageSize,
    defaults.defaultPageSize,
  );
  return { page, pageSize, isPaginated: hasPage };
}

export function paginate<T>(items: readonly T[], page: number, pageSize: number): PageEnvelope<T> {
  const total = items.length;
  const totalPages = total === 0 ? 1 : Math.ceil(total / pageSize);
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * pageSize;
  const slice = items.slice(start, start + pageSize);
  return {
    items: slice,
    page: safePage,
    pageSize,
    total,
    hasMore: start + slice.length < total,
  };
}

/** Split a flat `PageEnvelope<T>` into the `{ items, meta }` pair `defineRoute` handlers return. */
export function splitPaginated<T>(envelope: PageEnvelope<T>): { items: T[]; meta: PageMeta } {
  const { items, page, pageSize, total, hasMore } = envelope;
  return { items, meta: { page, pageSize, total, hasMore } };
}
