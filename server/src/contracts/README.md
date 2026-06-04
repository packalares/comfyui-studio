# Contracts + `defineRoute`

The canonical API surface lives here. Every wire shape is a Zod schema; every
route declares its contract via `defineRoute` so the runtime, the OpenAPI
emitter (wave 4), and the auth middleware (wave 2) all read from the same
source of truth.

## Defining a contract

Contracts are plain Zod schemas in `server/src/contracts/*.contract.ts`.
Export both the schema and the inferred type:

```ts
import { z } from 'zod';

export const CatalogModelSchema = z.object({
  filename: z.string(),
  name: z.string(),
  size_bytes: z.number().int().nonnegative(),
  installed: z.boolean(),
});
export type CatalogModel = z.infer<typeof CatalogModelSchema>;
```

Reuse schemas across routes by importing the schema — never re-declare a
field shape inline. The OpenAPI emit walks `defineRoute` specs and emits
each referenced schema once.

## Defining a route

```ts
import { z } from 'zod';
import { defineRoute } from '../lib/defineRoute.js';
import { CatalogModelSchema } from '../contracts/catalog.contract.js';
import { NotFoundError } from '../lib/errors.js';

export const catalogGetRoute = defineRoute({
  method: 'GET',
  path: '/catalog/models/:filename',
  params: z.object({ filename: z.string().min(1) }),
  query: z.object({ source: z.enum(['hf', 'civitai']).optional() }),
  response: CatalogModelSchema,
  auth: { required: true, scopes: ['catalog:read'] },
  tags: ['catalog'],
  summary: 'Fetch one catalog row by filename',
}, async (ctx) => {
  const row = await catalog.findByFilename(ctx.params.filename);
  if (!row) throw new NotFoundError('Model not found');
  return ctx.ok(row);
});
```

Mount onto an Express router:

```ts
import { Router } from 'express';
const router = Router();
catalogGetRoute.register(router);
export default router;
```

Throw `HttpError` subclasses (`NotFoundError`, `ValidationError`, ...) from
the handler; the helper translates them to the canonical error envelope.
For paginated lists, call `splitPaginated(...)` on the `paginate(...)`
result and pass the `meta` to `ctx.ok(items, meta)`.

## Error codes

| code                   | status | meaning                                                          |
| ---------------------- | ------ | ---------------------------------------------------------------- |
| `validation_failed`    | 400    | Zod parse failed on params/query/body.                           |
| `unauthorized`         | 401    | Missing or invalid credentials. Generic message, no `details`.   |
| `forbidden`            | 403    | Authenticated but lacks required scope. Generic, no `details`.   |
| `not_found`            | 404    | Target resource does not exist (or is hidden — see Security).    |
| `conflict`             | 409    | Write rejected by current state (uniqueness, version mismatch).  |
| `payload_too_large`    | 413    | Request body exceeds `UPLOAD_MAX_BYTES`.                         |
| `unsupported_media`    | 415    | Content-Type not accepted for this endpoint.                     |
| `rate_limited`         | 429    | Rate limit middleware tripped.                                   |
| `upstream_unavailable` | 502    | A backing service (ComfyUI, Ollama, HF) is unreachable.          |
| `internal_error`       | 500    | Unexpected throw. `details` only populated outside production.   |

## Security

- **Never leak internals in production.** The error middleware strips stack
  traces and raw error payloads when `NODE_ENV === 'production'`. The
  `internal_error` response carries an empty `details` field on prod.
- **Always set `auth`.** Omitting it produces a one-line boot warning until
  wave 2 wires the middleware. Choose `{ required: false }` only for probes
  (health, public manifests) — never silently.
- **Prefer `not_found` over `forbidden`** when the mere fact that a resource
  exists is sensitive. A `403` reveals "this resource is real, you just can't
  reach it"; a `404` reveals nothing. Reserve `forbidden` for cases where the
  resource's existence is already public.
- `401` and `403` responses never carry `details`. Sanitise internal context
  before throwing — the wire response stays generic regardless of dev/prod.
