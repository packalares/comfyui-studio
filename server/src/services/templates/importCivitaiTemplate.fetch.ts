// Fetch + workflow-discovery helpers for the Wave J CivitAI URL import.
// Split from `importCivitaiTemplate.ts` so that file stays under the
// structure-test line cap.

import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { getCivitaiAuthHeaders } from '../../lib/http.js';
import { looksLikeLitegraph } from './importStaging.js';
import { ImportCivitaiError } from './importCivitaiTemplate.urls.js';

const CIVITAI_IMAGES_URL = 'https://civitai.com/api/v1/images';
const IMAGES_PAGE_LIMIT = 50;

export const MAX_WORKFLOW_BYTES = 20 * 1024 * 1024; // 20 MB.
const FETCH_TIMEOUT_MS = 30_000;

export interface CivitaiModelVersion {
  id?: number;
  name?: string;
  files?: Array<{
    name?: string;
    type?: string;
    downloadUrl?: string;
    sizeKB?: number;
    primary?: boolean;
  }>;
  images?: Array<{
    url?: string;
    meta?: { workflow?: unknown } & Record<string, unknown>;
  }>;
}

export interface WorkflowCandidate {
  workflow: Record<string, unknown>;
  bytes: number;
  source: 'file' | 'image-meta';
  originFileName?: string;
}

/** Fetch JSON from civitai (or its CDN). Enforces MAX_WORKFLOW_BYTES. */
export async function fetchJsonBytes(url: string): Promise<Record<string, unknown>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...getCivitaiAuthHeaders(url, env.CIVITAI_TOKEN),
    };
    const res = await fetch(url, { signal: ctrl.signal, headers });
    if (res.status === 404) {
      throw new ImportCivitaiError('UPSTREAM_NOT_FOUND', `CivitAI returned 404 for ${url}`);
    }
    if (!res.ok) {
      throw new ImportCivitaiError(
        'UPSTREAM_FAILURE',
        `CivitAI request failed: ${res.status} ${res.statusText}`,
      );
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_WORKFLOW_BYTES) {
      throw new ImportCivitaiError(
        'PAYLOAD_TOO_LARGE',
        `Workflow JSON exceeds ${MAX_WORKFLOW_BYTES} byte cap`,
      );
    }
    const text = new TextDecoder('utf-8').decode(buf);
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch (err) {
      throw new ImportCivitaiError(
        'UPSTREAM_FAILURE',
        `CivitAI response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new ImportCivitaiError('UPSTREAM_FAILURE', 'CivitAI response was not an object');
    }
    return parsed as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Walk model versions for a ComfyUI workflow JSON. Files with
 * `type === 'Workflow'` or a `.json` suffix are tried first; falls back to
 * image.meta.workflow.
 */
export async function findWorkflow(versions: CivitaiModelVersion[]): Promise<WorkflowCandidate | null> {
  for (const version of versions) {
    const files = Array.isArray(version.files) ? version.files : [];
    for (const file of files) {
      const name = typeof file.name === 'string' ? file.name : '';
      const fileType = typeof file.type === 'string' ? file.type : '';
      const isWorkflow = fileType === 'Workflow' || /\.json$/i.test(name);
      const downloadUrl = typeof file.downloadUrl === 'string' ? file.downloadUrl : '';
      if (!isWorkflow || !downloadUrl) continue;
      try {
        const parsed = await fetchJsonBytes(downloadUrl);
        if (!looksLikeLitegraph(parsed)) continue;
        const bytes = JSON.stringify(parsed).length;
        return { workflow: parsed, bytes, source: 'file', originFileName: name };
      } catch (err) {
        if (err instanceof ImportCivitaiError && err.code === 'PAYLOAD_TOO_LARGE') throw err;
        logger.warn('civitai workflow file fetch failed', {
          name, error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  for (const version of versions) {
    const images = Array.isArray(version.images) ? version.images : [];
    const hit = scanImagesForWorkflow(images);
    if (hit) return hit;
  }
  // The model-detail response only embeds a tiny sample per version. Fall back
  // to /api/v1/images?modelVersionId=<id> for each version — that's where the
  // community-posted gallery (and any ComfyUI-embedded workflow metadata)
  // actually lives.
  for (const version of versions.slice(0, 2)) {
    if (typeof version.id !== 'number') continue;
    try {
      const extra = await fetchVersionImages(version.id);
      const hit = scanImagesForWorkflow(extra);
      if (hit) return hit;
    } catch (err) {
      logger.warn('civitai images-endpoint fallback failed', {
        versionId: version.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return null;
}

function scanImagesForWorkflow(
  images: Array<{ url?: string; meta?: Record<string, unknown> | null }>,
): WorkflowCandidate | null {
  for (const image of images) {
    const meta = image.meta;
    if (!meta || typeof meta !== 'object') continue;
    const raw = (meta as { workflow?: unknown }).workflow;
    let wf: unknown = raw;
    if (typeof raw === 'string') {
      try { wf = JSON.parse(raw); } catch { continue; }
    }
    if (!wf || typeof wf !== 'object') continue;
    if (!looksLikeLitegraph(wf)) continue;
    const bytes = JSON.stringify(wf).length;
    if (bytes > MAX_WORKFLOW_BYTES) continue;
    return { workflow: wf as Record<string, unknown>, bytes, source: 'image-meta' };
  }
  return null;
}

async function fetchVersionImages(
  versionId: number,
): Promise<Array<{ url?: string; meta?: Record<string, unknown> | null }>> {
  const url = `${CIVITAI_IMAGES_URL}?modelVersionId=${versionId}&limit=${IMAGES_PAGE_LIMIT}&nsfw=false`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json', ...getCivitaiAuthHeaders(url, env.CIVITAI_TOKEN) },
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { items?: unknown };
    return Array.isArray(body.items)
      ? (body.items as Array<{ url?: string; meta?: Record<string, unknown> | null }>)
      : [];
  } finally {
    clearTimeout(timer);
  }
}

/** Civitai tags come as strings or `{ name }` objects — normalise to strings. */
export function normaliseTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t === 'string' && t.trim()) out.push(t.trim());
    else if (t && typeof t === 'object') {
      const name = (t as { name?: unknown }).name;
      if (typeof name === 'string' && name.trim()) out.push(name.trim());
    }
  }
  return out;
}

/** Truncate HTML-heavy civitai descriptions so we don't store megabytes. */
export function trimDescription(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > 2_000 ? `${trimmed.slice(0, 2_000)}…` : trimmed;
}
