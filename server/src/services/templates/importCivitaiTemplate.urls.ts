// URL parser + typed error class for the Wave J CivitAI URL import flow.
// Split from `importCivitaiTemplate.ts` so that file stays under the
// structure-test line cap.

const CIVITAI_HOSTS = new Set(['civitai.com', 'www.civitai.com']);

/**
 * Typed error codes emitted by `stageFromCivitaiUrl`. Callers map these onto
 * HTTP status codes (`UNSUPPORTED_URL` -> 400, `NO_WORKFLOW_FOUND` -> 422,
 * `UPSTREAM_NOT_FOUND` -> 404, anything else -> 502).
 */
export type ImportCivitaiErrorCode =
  | 'UNSUPPORTED_URL'
  | 'NO_WORKFLOW_FOUND'
  | 'UPSTREAM_NOT_FOUND'
  | 'UPSTREAM_FAILURE'
  | 'PAYLOAD_TOO_LARGE';

export class ImportCivitaiError extends Error {
  public readonly code: ImportCivitaiErrorCode;
  constructor(code: ImportCivitaiErrorCode, message: string) {
    super(message);
    this.name = 'ImportCivitaiError';
    this.code = code;
  }
}

/** Parsed locator extracted from a CivitAI URL. */
export interface CivitaiUrlLocator {
  modelId?: number;
  versionId?: number;
}

/**
 * Parse a CivitAI URL into `{ modelId?, versionId? }`. Returns `null` when
 * the URL is malformed, not civitai-hosted, or doesn't match a known shape.
 *
 * Accepted shapes:
 *   https://civitai.com/models/<modelId>[/<slug>]
 *   https://civitai.com/models/<modelId>?modelVersionId=<versionId>
 *   https://civitai.com/api/download/models/<versionId>
 */
export function parseCivitaiTemplateUrl(raw: string): CivitaiUrlLocator | null {
  if (!raw || typeof raw !== 'string') return null;
  let u: URL;
  try { u = new URL(raw.trim()); }
  catch { return null; }
  if (!/^https?:$/i.test(u.protocol)) return null;
  if (!CIVITAI_HOSTS.has(u.hostname.toLowerCase())) return null;
  const parts = u.pathname.split('/').filter((p) => p.length > 0);
  // /api/download/models/<versionId>
  if (parts[0] === 'api' && parts[1] === 'download' && parts[2] === 'models') {
    const versionId = parseInt(parts[3] ?? '', 10);
    if (!Number.isFinite(versionId) || versionId <= 0) return null;
    return { versionId };
  }
  // /models/<modelId>[/<slug>][?modelVersionId=N]
  if (parts[0] === 'models') {
    const modelId = parseInt(parts[1] ?? '', 10);
    if (!Number.isFinite(modelId) || modelId <= 0) return null;
    const vidRaw = u.searchParams.get('modelVersionId');
    const versionId = vidRaw ? parseInt(vidRaw, 10) : NaN;
    if (Number.isFinite(versionId) && versionId > 0) {
      return { modelId, versionId };
    }
    return { modelId };
  }
  return null;
}
