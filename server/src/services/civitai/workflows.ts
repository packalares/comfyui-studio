// CivitAI "workflows" endpoints. GET-only. Ports launcher's
// `controllers/civitai/workflows.ts`.

import { env } from '../../config/env.js';
import { fetchWithRetry } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';
import { encodeQuery, type PageQuery, type CivitaiListResponse } from './models.js';

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
export async function getLatestWorkflows(q: PageQuery): Promise<CivitaiListResponse> {
  const params = buildParams(q, 24, 'Newest');
  logger.info('civitai latest workflows', { params });
  return (await fetchJson(
    `${apiBase()}/models${encodeQuery(params as unknown as Record<string, string | number | boolean>)}`,
  )) as CivitaiListResponse;
}

/** Hot workflows (Most Downloaded / Month). */
export async function getHotWorkflows(q: PageQuery): Promise<CivitaiListResponse> {
  const params = buildParams(q, 24, 'Most Downloaded', 'Month');
  logger.info('civitai hot workflows', { params });
  return (await fetchJson(
    `${apiBase()}/models${encodeQuery(params as unknown as Record<string, string | number | boolean>)}`,
  )) as CivitaiListResponse;
}

/**
 * Free-text workflow search. CivitAI requires cursor-based pagination when
 * `query=` is set (see models.ts header), so `page=` is never emitted here.
 */
export async function searchWorkflows(
  query: string,
  q: PageQuery,
): Promise<CivitaiListResponse> {
  if (!query || query.trim().length === 0) {
    throw new Error('Missing search query');
  }
  const limit = Number.isFinite(q.limit) ? Number(q.limit) : 24;
  const params: Record<string, string | number | boolean> = {
    limit,
    types: 'Workflows',
    query: query.trim(),
    sort: 'Highest Rated',
    period: 'AllTime',
    nsfw: false,
  };
  if (q.cursor) params.cursor = q.cursor;
  logger.info('civitai search workflows', { query, limit, cursor: q.cursor ?? null });
  return (await fetchJson(`${apiBase()}/models${encodeQuery(params)}`)) as CivitaiListResponse;
}

/**
 * Resolve a workflow version → a structured description of its primary file.
 * Used by the "import as template" flow to fetch the underlying workflow JSON
 * payload. Delegates to the `model-versions/:id` endpoint which always
 * returns a JSON document (unlike `/download/models/:id` which 302s to the
 * binary).
 *
 * Returns `{ downloadUrl, fileName, type }` on success; throws on 4xx/5xx.
 */
export async function getWorkflowVersionFile(versionId: string): Promise<{
  versionId: string;
  fileName: string;
  downloadUrl: string;
  type: string | null;
  format: string | null;
  modelId: number | null;
  modelName: string | null;
  isJsonFile: boolean;
}> {
  if (!versionId) throw new Error('Missing workflow version ID');
  const data = await fetchJson(`${apiBase()}/model-versions/${encodeURIComponent(versionId)}`);
  const d = data as Record<string, unknown>;
  const files = Array.isArray(d.files) ? d.files as Array<Record<string, unknown>> : [];
  if (files.length === 0) throw new Error('Workflow version has no downloadable files');
  // Prefer a JSON file if one is present (rare on civitai — most workflows
  // ship as .zip archives). Falls back to the primary file otherwise.
  const jsonFile = files.find((f) => {
    const name = typeof f.name === 'string' ? f.name.toLowerCase() : '';
    const type = typeof f.type === 'string' ? f.type.toLowerCase() : '';
    return name.endsWith('.json') || type === 'config';
  });
  const primary = jsonFile ?? files.find((f) => f.primary === true) ?? files[0];
  const fileName = typeof primary.name === 'string' ? primary.name : `workflow-${versionId}`;
  const downloadUrl = typeof primary.downloadUrl === 'string' ? primary.downloadUrl : '';
  if (!downloadUrl) throw new Error('Workflow version has no downloadUrl');
  const format = typeof (primary.metadata as Record<string, unknown> | undefined)?.format === 'string'
    ? ((primary.metadata as Record<string, unknown>).format as string)
    : null;
  const modelObj = d.model as Record<string, unknown> | undefined;
  return {
    versionId,
    fileName,
    downloadUrl,
    type: typeof primary.type === 'string' ? primary.type : null,
    format,
    modelId: typeof d.modelId === 'number' ? d.modelId : null,
    modelName: modelObj && typeof modelObj.name === 'string' ? modelObj.name : null,
    isJsonFile: fileName.toLowerCase().endsWith('.json'),
  };
}
