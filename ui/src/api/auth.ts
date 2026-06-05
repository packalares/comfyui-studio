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

export async function createApiKey(input: CreateApiKeyInput): Promise<CreatedApiKey> {
  return apiCall(createKeySpec, { body: input });
}

export async function listApiKeys(): Promise<ApiKey[]> {
  return apiCall(listKeysSpec, {});
}

export async function revokeApiKey(id: string): Promise<ApiKey> {
  return apiCall(revokeKeySpec, { params: { id } });
}
