// Typed wrappers for the API key management routes.

import { z } from 'zod';
import {
  ApiKeySchema,
  CreateApiKeyInputSchema,
  CreatedApiKeySchema,
  type ApiKey,
  type CreateApiKeyInput,
  type CreatedApiKey,
} from '@server/contracts/auth.contract';
import { apiCall } from './client.js';

// Route specs — mirrors auth.routes.ts without importing server code at runtime.

const createKeySpec = {
  method: 'POST' as const,
  path: '/auth/api-keys',
  body: CreateApiKeyInputSchema,
  response: CreatedApiKeySchema,
};

const listKeysSpec = {
  method: 'GET' as const,
  path: '/auth/api-keys',
  response: z.array(ApiKeySchema),
};

const revokeKeySpec = {
  method: 'DELETE' as const,
  path: '/auth/api-keys/:id',
  params: z.object({ id: z.string() }),
  response: ApiKeySchema,
};

const deleteKeySpec = {
  method: 'DELETE' as const,
  path: '/auth/api-keys/:id',
  params: z.object({ id: z.string() }),
  query: z.object({ hard: z.enum(['1', 'true']).optional() }),
  response: ApiKeySchema,
};

const cleanupKeysSpec = {
  method: 'POST' as const,
  path: '/auth/api-keys/cleanup',
  response: z.object({ deleted: z.number() }),
};

const ApiKeyRequestSchema = z.object({
  id: z.number(),
  ts: z.string(),
  endpoint: z.string(),
  model: z.string().nullable(),
  prompt: z.string(),
  response: z.string(),
  status: z.number().nullable(),
});
export type ApiKeyRequest = z.infer<typeof ApiKeyRequestSchema>;

const keyRequestsSpec = {
  method: 'GET' as const,
  path: '/auth/api-keys/:id/requests',
  params: z.object({ id: z.string() }),
  response: z.array(ApiKeyRequestSchema),
};

export async function createApiKey(input: CreateApiKeyInput): Promise<CreatedApiKey> {
  return apiCall(createKeySpec, { body: input });
}

export async function listApiKeys(): Promise<ApiKey[]> {
  return apiCall(listKeysSpec, {});
}

export async function revokeApiKey(id: string): Promise<ApiKey> {
  return apiCall(revokeKeySpec, { params: { id } });
}

/** Permanently delete one key (hard delete — row removed, not just revoked). */
export async function deleteApiKey(id: string): Promise<ApiKey> {
  return apiCall(deleteKeySpec, { params: { id }, query: { hard: '1' } });
}

/** Bulk-delete all revoked/expired keys. Returns how many were removed. */
export async function cleanupApiKeys(): Promise<{ deleted: number }> {
  return apiCall(cleanupKeysSpec, {});
}

/** Last N logged requests (prompt + response) made with this key. */
export async function listApiKeyRequests(id: string): Promise<ApiKeyRequest[]> {
  return apiCall(keyRequestsSpec, { params: { id } });
}
