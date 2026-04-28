// CivitAI model URL resolver.
//
// Translates any public CivitAI link the user pastes into a concrete
// `ResolvedModel` the launcher can download. Handles the three shapes a
// model page naturally produces:
//
//   https://civitai.com/models/<modelId>
//   https://civitai.com/models/<modelId>/<slug>?modelVersionId=<versionId>
//   https://civitai.com/api/download/models/<versionId>
//
// Public endpoints work without a token; when `env.CIVITAI_TOKEN` is set we
// forward it as `Authorization: Bearer`. Returns null (never throws) for
// malformed URLs, 404s, or empty `files[]` arrays — the caller uses the
// null to surface a neutral "could not resolve" error in the UI.

import { env } from '../../config/env.js';
import type { ResolvedModel, SuggestedFolder } from './resolveHuggingface.js';

const CIVITAI_HOSTS = new Set(['civitai.com', 'www.civitai.com']);

interface CivitaiFile {
  id?: number;
  sizeKB?: number;
  name?: string;
  type?: string;
  primary?: boolean;
  downloadUrl?: string;
  metadata?: Record<string, unknown>;
}

interface CivitaiModelVersion {
  id: number;
  name?: string;
  modelId?: number;
  baseModel?: string;
  downloadUrl?: string;
  files?: CivitaiFile[];
  model?: { type?: string; name?: string };
}

interface CivitaiModel {
  id: number;
  name?: string;
  type?: string;
  modelVersions?: CivitaiModelVersion[];
}

type CivitaiUrlKind =
  | { kind: 'model'; modelId: number; versionId?: number }
  | { kind: 'download'; versionId: number };

/**
 * Type->folder mapping cribbed from the CivitAI model-type vocabulary the
 * existing catalog already understands. Extends the HF set with
 * `embeddings` so TextualInversion rows land in the right place.
 */
function civitaiTypeToFolder(type: string | undefined): SuggestedFolder | undefined {
  const t = (type || '').toLowerCase();
  if (!t) return undefined;
  if (t === 'checkpoint') return 'checkpoints';
  if (t === 'lora' || t === 'locon' || t === 'lycoris') return 'loras';
  if (t === 'textualinversion' || t === 'textual inversion' || t === 'embedding') return 'embeddings';
  if (t === 'vae') return 'vae';
  if (t === 'controlnet') return 'controlnet';
  if (t === 'upscaler') return 'upscale_models';
  return undefined;
}

function parseCivitaiUrl(raw: string): CivitaiUrlKind | null {
  let u: URL;
  try { u = new URL(raw); }
  catch { return null; }
  const host = u.hostname.toLowerCase();
  if (!CIVITAI_HOSTS.has(host)) return null;
  const parts = u.pathname.split('/').filter((p) => p.length > 0);
  // /api/download/models/<versionId>
  if (parts[0] === 'api' && parts[1] === 'download' && parts[2] === 'models') {
    const versionId = parseInt(parts[3] ?? '', 10);
    if (!Number.isFinite(versionId) || versionId <= 0) return null;
    return { kind: 'download', versionId };
  }
  // /models/<modelId>[/<slug>]
  if (parts[0] === 'models') {
    const modelId = parseInt(parts[1] ?? '', 10);
    if (!Number.isFinite(modelId) || modelId <= 0) return null;
    const vidRaw = u.searchParams.get('modelVersionId');
    const versionId = vidRaw ? parseInt(vidRaw, 10) : NaN;
    if (Number.isFinite(versionId) && versionId > 0) {
      return { kind: 'model', modelId, versionId };
    }
    return { kind: 'model', modelId };
  }
  return null;
}

function apiBase(): string {
  // Honour the env.CIVITAI_API_BASE override so tests / private proxies can
  // point elsewhere. Defaults to the public civitai API.
  return env.CIVITAI_API_BASE;
}

function civitaiAuthHeaders(): Record<string, string> {
  const token = env.CIVITAI_TOKEN;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Outcome of a CivitAI JSON fetch carrying enough info for status branching.
 * `status: 0` is reserved for network/timeout/transient errors so the caller
 * can keep the URL on the row but skip the size + gated branches. */
interface JsonOutcome<T> { status: number; body?: T }

async function fetchJson<T>(url: string): Promise<JsonOutcome<T>> {
  try {
    const res = await fetch(url, { headers: civitaiAuthHeaders() });
    if (res.status !== 200) return { status: res.status };
    const body = (await res.json()) as T;
    return { status: 200, body };
  } catch {
    return { status: 0 };
  }
}

/** Prefer the `primary` flagged file; fall back to the first entry. */
function pickFile(files: CivitaiFile[] | undefined): CivitaiFile | null {
  if (!files || files.length === 0) return null;
  const primary = files.find((f) => f.primary);
  return primary ?? files[0];
}

function buildResolvedFromVersion(
  version: CivitaiModelVersion,
  modelType: string | undefined,
): ResolvedModel | null {
  const file = pickFile(version.files);
  if (!file) return null;
  const downloadUrl = file.downloadUrl
    || version.downloadUrl
    || `https://civitai.com/api/download/models/${version.id}`;
  const fileName = file.name || `civitai-${version.id}`;
  const sizeBytes = typeof file.sizeKB === 'number' && file.sizeKB > 0
    ? Math.round(file.sizeKB * 1024)
    : undefined;
  const effectiveType = modelType ?? version.model?.type;
  const resolved: ResolvedModel = {
    source: 'civitai',
    downloadUrl,
    fileName,
    civitai: {
      modelId: version.modelId ?? 0,
      versionId: version.id,
      modelType: effectiveType,
      baseModel: version.baseModel,
    },
  };
  if (typeof sizeBytes === 'number') resolved.sizeBytes = sizeBytes;
  const folder = civitaiTypeToFolder(effectiveType);
  if (folder) resolved.suggestedFolder = folder;
  return resolved;
}

/** Build a minimal `ResolvedModel` carrying only a downloadUrl + filename
 * placeholder. The caller decorates it with `gated` (401/403) or leaves it
 * naked (5xx / network) so the row gets recorded but no size/folder/civitai
 * metadata is invented from thin air. */
function stubResolved(downloadUrl: string, fileName: string): ResolvedModel {
  return { source: 'civitai', downloadUrl, fileName };
}

function withGated(stub: ResolvedModel): ResolvedModel {
  return {
    ...stub,
    gated: true,
    gatedMessage: 'paste your CivitAI token in Settings to download',
  };
}

/** Map civitai HTTP status -> resolver result.
 *   - 200 (with body): full resolution from `files[]`.
 *   - 401 / 403: stub + `gated: true`.
 *   - 404 / 410: null (URL truly bad).
 *   - 5xx / network: bare stub (no size, no gated) so the catalog row keeps
 *     a usable URL while we wait for a retry.
 */
async function resolveByVersionId(versionId: number): Promise<ResolvedModel | null> {
  const downloadUrl = `https://civitai.com/api/download/models/${versionId}`;
  const fileName = `civitai-${versionId}`;
  const out = await fetchJson<CivitaiModelVersion>(
    `${apiBase()}/model-versions/${versionId}`,
  );
  if (out.status === 404 || out.status === 410) return null;
  if (out.status === 401 || out.status === 403) return withGated(stubResolved(downloadUrl, fileName));
  if (out.status === 200) {
    if (!out.body || typeof out.body.id !== 'number') return null;
    return buildResolvedFromVersion(out.body, out.body.model?.type);
  }
  // 5xx / network / 0: keep the URL, drop the size + folder.
  return stubResolved(downloadUrl, fileName);
}

async function resolveByModelId(
  modelId: number, versionId?: number,
): Promise<ResolvedModel | null> {
  if (typeof versionId === 'number') return resolveByVersionId(versionId);
  const out = await fetchJson<CivitaiModel>(`${apiBase()}/models/${modelId}`);
  // We don't know a versionId yet; the placeholder URL points at the
  // model page so the catalog still records the host requirement.
  const placeholderUrl = `https://civitai.com/models/${modelId}`;
  const placeholderFile = `civitai-${modelId}`;
  if (out.status === 404 || out.status === 410) return null;
  if (out.status === 401 || out.status === 403) {
    return withGated(stubResolved(placeholderUrl, placeholderFile));
  }
  if (out.status === 200) {
    if (!out.body || !Array.isArray(out.body.modelVersions) || out.body.modelVersions.length === 0) {
      return null;
    }
    const model = out.body;
    const version = model.modelVersions![0];
    // Inject the parent modelId when the embedded version doesn't carry it.
    if (typeof version.modelId !== 'number') version.modelId = model.id;
    return buildResolvedFromVersion(version, model.type ?? version.model?.type);
  }
  // 5xx / network / 0: keep the URL placeholder so the catalog still
  // records the host, drop everything we'd normally fill from `files[]`.
  return stubResolved(placeholderUrl, placeholderFile);
}

/**
 * Resolve a civitai.com URL into a downloadable `ResolvedModel`. Returns
 * null (never throws) for malformed URLs, upstream 404s, or responses
 * missing a usable file entry.
 */
export async function resolveCivitaiUrl(url: string): Promise<ResolvedModel | null> {
  if (typeof url !== 'string' || url.length === 0) return null;
  const parsed = parseCivitaiUrl(url);
  if (!parsed) return null;
  if (parsed.kind === 'download') {
    return resolveByVersionId(parsed.versionId);
  }
  return resolveByModelId(parsed.modelId, parsed.versionId);
}
