// Canonical shapes for the API-key auth layer.
//
// Three Zod schemas:
//   - ApiKeySchema        — the public view returned by list / get. Never
//                           includes the plain secret or the stored hash.
//   - CreateApiKeyInputSchema — body of POST /auth/keys.
//   - CreatedApiKeySchema — one-time response of POST /auth/keys; carries the
//                           plain secret. Wave 2b must never echo this shape
//                           back from any other route.
//
// Timestamps are ISO-8601 strings at the contract boundary; the DB layer keeps
// epoch-ms integers — see `apiKeys.repo.ts` for the conversion.

import { z } from 'zod';

// Canonical scope registry. Moved here so UI-side tsc does not need to chase
// the import chain into server-only modules (express, better-sqlite3, etc.).
// server/src/lib/auth/scopes.ts re-exports from this file for back-compat.
export const SCOPES = [
  'catalog:read',
  'catalog:write',
  'models:read',
  'models:write',
  'models:install',
  'chat:read',
  'chat:write',
  'videoboard:read',
  'videoboard:write',
  'videoboard:render',
  'gallery:read',
  'gallery:write',
  'gallery:delete',
  'generate:write',
  'system:read',
  'system:write',
  'settings:read',
  'settings:write',
  'packs:install',
  'ws:connect',
  'admin:keys',
  'admin:all',
] as const;

export type Scope = typeof SCOPES[number];

export const ScopeSchema: z.ZodType<Scope> = z.enum(SCOPES);

export const ApiKeySchema = z.object({
  id: z.string().min(1),
  prefix: z.string().min(1),
  name: z.string().min(1),
  scopes: z.array(ScopeSchema),
  createdAt: z.string().datetime(),
  lastUsedAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
});
export type ApiKey = z.infer<typeof ApiKeySchema>;

export const CreateApiKeyInputSchema = z.object({
  name: z.string().min(1).max(120),
  scopes: z.array(ScopeSchema).min(1),
  /** Optional absolute expiry. Omit / null = key never auto-expires. */
  expiresAt: z.string().datetime().nullable().optional(),
});
export type CreateApiKeyInput = z.infer<typeof CreateApiKeyInputSchema>;

export const CreatedApiKeySchema = ApiKeySchema.extend({
  /** Plain secret. Returned exactly once at creation; never persisted plaintext. */
  plain: z.string().min(1),
});
export type CreatedApiKey = z.infer<typeof CreatedApiKeySchema>;
