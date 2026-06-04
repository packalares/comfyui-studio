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
import { SCOPES, type Scope } from '../lib/auth/scopes.js';

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
