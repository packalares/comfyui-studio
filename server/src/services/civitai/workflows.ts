// CivitAI "workflows" endpoints. GET-only. Ports launcher's
// `controllers/civitai/workflows.ts`.

import { env } from '../../config/env.js';
import { fetchWithRetry } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';
import { encodeQuery, type PageQuery } from './models.js';

function apiBase(): string { return env.CIVITAI_API_BASE; }
function maxBytes(): number { return env.CIVITAI_MAX_RESPONSE_BYTES; }

async function fetchJson(url: string): Promise<unknown> {
  const r = await fetchWithRetry(url, {
    attempts: 3,
    baseDelayMs: 500,
    timeoutMs: 15_000,
    maxBytes: maxBytes(),
    headers: { Accept: 'application/json' },
  });
  try { return JSON.parse(r.text); }
  catch (err) {
    throw new Error(`Civitai response was not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

interface WorkflowParams {
  limit: number;
  types: string;
  sort: string;
  nsfw: boolean;
  period?: string;
  cursor?: string;
  page?: number;
}

function buildParams(q: PageQuery, defaultLimit: number, sort: string, period?: string): WorkflowParams {
  const out: WorkflowParams = {
    limit: Number.isFinite(q.limit) ? Number(q.limit) : defaultLimit,
    types: 'Workflows',
    sort,
    nsfw: false,
  };
  if (period) out.period = period;
  if (q.cursor) out.cursor = q.cursor;
  else out.page = Number.isFinite(q.page) ? Number(q.page) : 1;
  return out;
}

/** Latest workflows (Newest). */
export async function getLatestWorkflows(q: PageQuery): Promise<unknown> {
  const params = buildParams(q, 24, 'Newest');
  logger.info('civitai latest workflows', { params });
  return fetchJson(`${apiBase()}/models${encodeQuery(params as unknown as Record<string, string | number | boolean>)}`);
}

/** Hot workflows (Most Downloaded / Month). */
export async function getHotWorkflows(q: PageQuery): Promise<unknown> {
  const params = buildParams(q, 24, 'Most Downloaded', 'Month');
  logger.info('civitai hot workflows', { params });
  return fetchJson(`${apiBase()}/models${encodeQuery(params as unknown as Record<string, string | number | boolean>)}`);
}
