// Paste-a-URL → ResolvedModel for three hosts: HuggingFace, CivitAI, GitHub.
// Each resolver section is independent; they share the ResolvedModel type.

import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { getGithubAuthHeaders } from '../../lib/http.js';
import { getGithubToken } from '../settings/index.js';

// ── Shared types ──────────────────────────────────────────────────────────────

export type SuggestedFolder =
  | 'checkpoints'
  | 'loras'
  | 'vae'
  | 'clip'
  | 'controlnet'
  | 'upscale_models'
  | 'unet'
  | 'embeddings';

export interface ResolvedModel {
  source: 'huggingface' | 'civitai';
  /** Direct HTTPS URL the launcher can stream into models/. */
  downloadUrl: string;
  fileName: string;
  sizeBytes?: number;
  suggestedFolder?: SuggestedFolder;
  /** HuggingFace `<org>/<repo>` identifier. Present on HF results. */
  repoId?: string;
  /** Git ref (branch, tag, commit). Present on HF results. */
  revision?: string;
  /**
   * Set when a HEAD-probe came back 401/403. The catalog row + UI can then
   * surface a "paste your token in Settings" prompt instead of treating the
   * URL as broken. Transient errors (5xx, network) leave this undefined so
   * the row still gets populated and a later retry can succeed.
   */
  gated?: boolean;
  gatedMessage?: string;
  /** CivitAI-only metadata. */
  civitai?: {
    modelId: number;
    versionId: number;
    modelType?: string;
    baseModel?: string;
  };
}

// ── HuggingFace ───────────────────────────────────────────────────────────────
//
// Used by Wave E's manual "Resolve via URL" affordance on the import review
// step. Takes a public HuggingFace URL, normalises `/blob/` -> `/resolve/`
// for direct download, HEADs the result to learn the byte size, and infers
// the ComfyUI models folder the file belongs in.
//
// Deliberately narrow: the resolver only understands file URLs. Repo-root
// URLs return null because there is no reliable way to pick a single file
// out of a multi-file repo automatically.

const MODEL_FILE_EXT_RE = /\.(safetensors|pth|pt|bin|ckpt|gguf)$/i;

/**
 * Path-segment + extension based placement heuristic. Keeps things obvious:
 * if the HF repo path contains `/loras/` we trust it, otherwise fall back to
 * filename hints, otherwise fall back to `checkpoints` for any known weight
 * extension. Returns `undefined` when nothing matches so the caller can
 * display "unknown — please set save_path manually".
 */
export function guessFolder(pathInRepo: string, fileName: string): SuggestedFolder | undefined {
  // Normalise path with leading + trailing slashes so the per-segment regexes
  // work whether the caller passed a rooted path ("/foo/bar") or a relative
  // one ("foo/bar").
  const lowerPath = `/${pathInRepo.toLowerCase().replace(/^\/+/, '')}/`;
  const lowerName = fileName.toLowerCase();
  if (/\/loras?\//.test(lowerPath) || /(^|[_-])lora([_-]|\.)/.test(lowerName)) return 'loras';
  if (/\/vae\//.test(lowerPath) || /(^|[_-])vae([_-]|\.)/.test(lowerName)) return 'vae';
  if (/\/controlnet\//.test(lowerPath) || /controlnet/.test(lowerName)) return 'controlnet';
  if (/\/clip\//.test(lowerPath) || /(^|[_-])clip([_-]|\.)/.test(lowerName)) return 'clip';
  if (/\/upscale/.test(lowerPath) || /upscal(er|e)/.test(lowerName)) return 'upscale_models';
  if (/\/unet\//.test(lowerPath) || /(^|[_-])unet([_-]|\.)/.test(lowerName)) return 'unet';
  if (/\/embeddings?\//.test(lowerPath) || /\/textual_inversion\//.test(lowerPath)) return 'embeddings';
  if (MODEL_FILE_EXT_RE.test(lowerName)) return 'checkpoints';
  return undefined;
}

interface ParsedHfFile {
  repoId: string;
  revision: string;
  pathInRepo: string;
  repoType: 'model' | 'dataset';
}

/**
 * Accepts the four file-URL shapes HF exposes publicly:
 *   - https://huggingface.co/<org>/<repo>/blob/<ref>/<path>
 *   - https://huggingface.co/<org>/<repo>/resolve/<ref>/<path>
 *   - https://huggingface.co/datasets/<org>/<repo>/blob/<ref>/<path>
 *   - https://huggingface.co/datasets/<org>/<repo>/resolve/<ref>/<path>
 *
 * Repo-root URLs (no /blob/ or /resolve/) return null; Spaces URLs are
 * rejected because they aren't single-file artifacts.
 */
export function parseHfFileUrl(raw: string): ParsedHfFile | null {
  let u: URL;
  try { u = new URL(raw); }
  catch { return null; }
  const host = u.hostname.toLowerCase();
  if (host !== 'huggingface.co' && host !== 'www.huggingface.co') return null;
  const parts = u.pathname.split('/').filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  if (parts[0] === 'spaces') return null;
  let repoType: 'model' | 'dataset' = 'model';
  let cursor = 0;
  if (parts[0] === 'datasets') { repoType = 'dataset'; cursor = 1; }
  if (parts.length - cursor < 5) return null;
  const org = parts[cursor];
  const repo = parts[cursor + 1];
  const kind = parts[cursor + 2];
  const ref = parts[cursor + 3];
  const rest = parts.slice(cursor + 4);
  if (kind !== 'blob' && kind !== 'resolve') return null;
  if (rest.length === 0) return null;
  return {
    repoId: `${org}/${repo}`,
    revision: ref,
    pathInRepo: rest.join('/'),
    repoType,
  };
}

function buildHfResolveUrl(parsed: ParsedHfFile): string {
  const encodedPath = parsed.pathInRepo.split('/').map(encodeURIComponent).join('/');
  const prefix = parsed.repoType === 'dataset' ? 'datasets/' : '';
  return `https://huggingface.co/${prefix}${parsed.repoId}/resolve/${encodeURIComponent(parsed.revision)}/${encodedPath}`;
}

function hfAuthHeaders(): Record<string, string> {
  const token = env.HUGGINGFACE_TOKEN;
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

interface HeadOutcome { status: number; sizeBytes?: number }

async function headSize(url: string): Promise<HeadOutcome> {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      headers: hfAuthHeaders(),
      redirect: 'follow',
    });
    if (res.status !== 200) return { status: res.status };
    const linked = res.headers.get('x-linked-size');
    const contentLength = res.headers.get('content-length');
    const bytes = linked ? Number(linked) : contentLength ? Number(contentLength) : NaN;
    const out: HeadOutcome = { status: 200 };
    if (Number.isFinite(bytes) && bytes > 0) out.sizeBytes = bytes;
    return out;
  } catch {
    return { status: 0 };
  }
}

/**
 * Resolve a HuggingFace URL into a `ResolvedModel`. Returns null (not
 * throws) for malformed URLs or repo-root links we cannot disambiguate.
 *
 * HEAD status mapping:
 *   - 200      → populate `sizeBytes`, return resolved.
 *   - 401/403  → return resolved with `gated: true` + a Settings-token prompt.
 *   - 404/410  → return null (URL is truly bad, caller treats as unresolved).
 *   - 5xx / network / timeout / 0 → return resolved with no size, no gated
 *     flag (transient — let the caller retry later).
 */
export async function resolveHuggingfaceUrl(url: string): Promise<ResolvedModel | null> {
  if (typeof url !== 'string' || url.length === 0) return null;
  const parsed = parseHfFileUrl(url);
  if (!parsed) return null;
  const downloadUrl = buildHfResolveUrl(parsed);
  const fileName = parsed.pathInRepo.split('/').pop() || parsed.pathInRepo;
  const suggestedFolder = guessFolder(parsed.pathInRepo, fileName);
  const head = await headSize(downloadUrl);
  if (head.status === 404 || head.status === 410) return null;
  const resolved: ResolvedModel = {
    source: 'huggingface',
    downloadUrl,
    fileName,
    repoId: parsed.repoId,
    revision: parsed.revision,
  };
  if (head.status === 401 || head.status === 403) {
    resolved.gated = true;
    resolved.gatedMessage = 'paste your Hugging Face token in Settings to download';
  }
  if (typeof head.sizeBytes === 'number') resolved.sizeBytes = head.sizeBytes;
  if (suggestedFolder) resolved.suggestedFolder = suggestedFolder;
  return resolved;
}

// ── CivitAI ───────────────────────────────────────────────────────────────────
//
// Translates any public CivitAI link the user pastes into a concrete
// `ResolvedModel` the launcher can download. Handles three shapes:
//   https://civitai.com/models/<modelId>
//   https://civitai.com/models/<modelId>/<slug>?modelVersionId=<versionId>
//   https://civitai.com/api/download/models/<versionId>
//
// Public endpoints work without a token; when `env.CIVITAI_TOKEN` is set we
// forward it as `Authorization: Bearer`. Returns null (never throws) for
// malformed URLs, 404s, or empty `files[]` arrays.

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

function civitaiApiBase(): string {
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
 * naked (5xx / network) so the row gets recorded but no metadata is invented. */
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

/**
 * Map civitai HTTP status -> resolver result.
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
    `${civitaiApiBase()}/model-versions/${versionId}`,
  );
  if (out.status === 404 || out.status === 410) return null;
  if (out.status === 401 || out.status === 403) return withGated(stubResolved(downloadUrl, fileName));
  if (out.status === 200) {
    if (!out.body || typeof out.body.id !== 'number') return null;
    return buildResolvedFromVersion(out.body, out.body.model?.type);
  }
  return stubResolved(downloadUrl, fileName);
}

async function resolveByModelId(
  modelId: number, versionId?: number,
): Promise<ResolvedModel | null> {
  if (typeof versionId === 'number') return resolveByVersionId(versionId);
  const out = await fetchJson<CivitaiModel>(`${civitaiApiBase()}/models/${modelId}`);
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

// ── GitHub ────────────────────────────────────────────────────────────────────
//
// Accepts canonical release-asset URL shapes:
//   - https://github.com/<owner>/<repo>/releases/download/<tag>/<file>
//   - https://github.com/<owner>/<repo>/releases/download/<tag>/<file>?token=...
//
// Probes file size via the public REST API
// (`GET /repos/<owner>/<repo>/releases/tags/<tag>`) so we don't need to
// follow the redirect to the signed S3 asset just to learn the byte count.
// The returned `downloadUrl` is the canonical github.com URL — the engine
// (and the walker on retry) re-resolves the signed CDN URL with a fresh GET
// because the signature is short-lived and would otherwise expire mid-retry.

interface ParsedGhRelease {
  owner: string;
  repo: string;
  tag: string;
  fileName: string;
  /** Canonical github.com download URL (always re-resolvable on retry). */
  canonicalUrl: string;
}

/** Public for tests. Returns null on any non-release github URL. */
export function parseGithubReleaseUrl(raw: string): ParsedGhRelease | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  const host = u.hostname.toLowerCase();
  if (host !== 'github.com' && host !== 'www.github.com') return null;
  const parts = u.pathname.split('/').filter((p) => p.length > 0);
  // <owner>/<repo>/releases/download/<tag>/<file...>
  if (parts.length < 6) return null;
  if (parts[2] !== 'releases' || parts[3] !== 'download') return null;
  const owner = parts[0];
  const repo = parts[1];
  const tag = parts[4];
  const fileSegments = parts.slice(5);
  const fileName = decodeURIComponent(fileSegments[fileSegments.length - 1] || '');
  if (!fileName) return null;
  const canonicalUrl = `https://github.com/${owner}/${repo}/releases/download/${encodeURIComponent(tag)}/${fileSegments.map(encodeURIComponent).join('/')}`;
  return { owner, repo, tag, fileName, canonicalUrl };
}

interface GhAsset {
  name?: string;
  size?: number;
  browser_download_url?: string;
}

interface GhReleaseResponse {
  assets?: GhAsset[];
}

/** `status: 0` flags network/timeout/transient errors. */
interface AssetOutcome { status: number; sizeBytes?: number }

async function fetchAssetSize(p: ParsedGhRelease): Promise<AssetOutcome> {
  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(p.owner)}/${encodeURIComponent(p.repo)}/releases/tags/${encodeURIComponent(p.tag)}`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...getGithubAuthHeaders(apiUrl, getGithubToken()),
  };
  try {
    const res = await fetch(apiUrl, { headers, redirect: 'follow' });
    if (res.status !== 200) return { status: res.status };
    const body = await res.json() as GhReleaseResponse;
    const asset = (body.assets || []).find(a => a.name === p.fileName);
    if (!asset || typeof asset.size !== 'number' || asset.size <= 0) return { status: 200 };
    return { status: 200, sizeBytes: asset.size };
  } catch (err) {
    logger.warn('resolveGithub size probe failed', {
      url: apiUrl, message: err instanceof Error ? err.message : String(err),
    });
    return { status: 0 };
  }
}

/**
 * Resolve a GitHub release asset URL into a `ResolvedModel`. Returns null
 * for any URL outside the release-asset shape so callers can fall through
 * to other resolvers.
 *
 * API status mapping:
 *   - 200      → populate sizeBytes when present, return resolved.
 *   - 401/403  → return resolved with `gated: true` + Settings-token prompt.
 *   - 404/410 / 5xx / network — return resolved with no size and no gated
 *     flag. Unlike HF/CivitAI we never null on 404 here: the API endpoint
 *     we probe (`releases/tags/<tag>`) is a SIZE-only side-channel — the
 *     download URL itself is parsed locally from the user's input and
 *     remains valid even if the tags API can't see the release.
 */
export async function resolveGithubReleaseUrl(url: string): Promise<ResolvedModel | null> {
  if (typeof url !== 'string' || url.length === 0) return null;
  const parsed = parseGithubReleaseUrl(url);
  if (!parsed) return null;
  const probe = await fetchAssetSize(parsed);
  const suggestedFolder: SuggestedFolder | undefined = guessFolder('', parsed.fileName);
  const out: ResolvedModel = {
    source: 'github' as unknown as ResolvedModel['source'],
    downloadUrl: parsed.canonicalUrl,
    fileName: parsed.fileName,
  };
  if (probe.status === 401 || probe.status === 403) {
    out.gated = true;
    out.gatedMessage = 'paste your GitHub token in Settings to download';
  }
  if (typeof probe.sizeBytes === 'number') out.sizeBytes = probe.sizeBytes;
  if (suggestedFolder) out.suggestedFolder = suggestedFolder;
  return out;
}
