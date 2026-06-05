// API key management routes. All three are auth-gated with scope `admin:keys`.
// The plain secret is returned exactly once (on creation) and never stored.

import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../lib/defineRoute.js';
import {
  ApiKeySchema,
  CreateApiKeyInputSchema,
  CreatedApiKeySchema,
} from '../contracts/auth.contract.js';
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from '../lib/db/apiKeys.repo.js';
import { generateKey } from '../lib/auth/keyGen.js';
import { NotFoundError } from '../lib/errors.js';

/** Epoch ms → ISO-8601 string. */
function ms(n: number): string {
  return new Date(n).toISOString();
}
/** Epoch ms | null → ISO-8601 | null. */
function msn(n: number | null): string | null {
  return n === null ? null : new Date(n).toISOString();
}

const AUTH_SCOPE = { required: true, scopes: ['admin:keys'] } as const;

// POST /api/auth/api-keys — create a new key. Returns plain secret once.
const createKeyRoute = defineRoute(
  {
    method: 'POST',
    path: '/auth/api-keys',
    body: CreateApiKeyInputSchema,
    response: CreatedApiKeySchema,
    auth: AUTH_SCOPE,
    tags: ['auth'],
    summary: 'Create API key',
  },
  (ctx) => {
    const { name, scopes, expiresAt } = ctx.body;
    const { prefix, plain, hash } = generateKey();
    const record = createApiKey({
      prefix,
      hash,
      name,
      scopes,
      expiresAt: expiresAt ? new Date(expiresAt).getTime() : null,
    });
    return ctx.ok({
      id: record.id,
      prefix: record.prefix,
      name: record.name,
      scopes: record.scopes,
      createdAt: ms(record.createdAt),
      lastUsedAt: msn(record.lastUsedAt),
      expiresAt: msn(record.expiresAt),
      revokedAt: msn(record.revokedAt),
      plain,
    });
  },
);

// GET /api/auth/api-keys — list keys, no hashes/secrets.
const listKeysRoute = defineRoute(
  {
    method: 'GET',
    path: '/auth/api-keys',
    response: z.array(ApiKeySchema),
    auth: AUTH_SCOPE,
    tags: ['auth'],
    summary: 'List API keys',
  },
  (ctx) => {
    const records = listApiKeys();
    return ctx.ok(
      records.map((r) => ({
        id: r.id,
        prefix: r.prefix,
        name: r.name,
        scopes: r.scopes,
        createdAt: ms(r.createdAt),
        lastUsedAt: msn(r.lastUsedAt),
        expiresAt: msn(r.expiresAt),
        revokedAt: msn(r.revokedAt),
      })),
    );
  },
);

// DELETE /api/auth/api-keys/:id — revoke.
const revokeKeyRoute = defineRoute(
  {
    method: 'DELETE',
    path: '/auth/api-keys/:id',
    params: z.object({ id: z.string().min(1) }),
    response: ApiKeySchema,
    auth: AUTH_SCOPE,
    tags: ['auth'],
    summary: 'Revoke API key',
  },
  (ctx) => {
    const updated = revokeApiKey(ctx.params.id);
    if (!updated) throw new NotFoundError('API key not found');
    return ctx.ok({
      id: updated.id,
      prefix: updated.prefix,
      name: updated.name,
      scopes: updated.scopes,
      createdAt: ms(updated.createdAt),
      lastUsedAt: msn(updated.lastUsedAt),
      expiresAt: msn(updated.expiresAt),
      revokedAt: msn(updated.revokedAt),
    });
  },
);

const router = Router();
createKeyRoute.register(router);
listKeysRoute.register(router);
revokeKeyRoute.register(router);

export default router;
