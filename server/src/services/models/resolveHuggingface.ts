// HuggingFace model URL resolver.
//
// Used by Wave E's manual "Resolve via URL" affordance on the import review
// step. Takes a public HuggingFace URL, normalises `/blob/` -> `/resolve/`
// for direct download, HEADs the result to learn the byte size, and infers
// the ComfyUI models folder the file belongs in (checkpoints, loras, ...).
//
// Deliberately narrow: the resolver only understands file URLs. Repo-root
// URLs return null because there is no reliable way to pick a single file
// out of a multi-file repo automatically — that ambiguity is surfaced to
// the user who can then paste the specific /blob/ link.

import { env } from '../../config/env.js';

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
  // one ("foo/bar"). This also lets us treat the first segment uniformly.
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
  /** Repo type controls the URL prefix used when reconstructing /resolve/. */
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
  // Need org, repo, kind, ref, +1 path part.
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

function buildResolveUrl(parsed: ParsedHfFile): string {
  const encodedPath = parsed.pathInRepo.split('/').map(encodeURIComponent).join('/');
  const prefix = parsed.repoType === 'dataset' ? 'datasets/' : '';
  return `https://huggingface.co/${prefix}${parsed.repoId}/resolve/${encodeURIComponent(parsed.revision)}/${encodedPath}`;
}

function hfAuthHeaders(): Record<string, string> {
  const token = env.HUGGINGFACE_TOKEN;
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

/** HEAD outcome: numeric `status` is always set; `sizeBytes` is populated
 * only on a 200. `status: 0` flags a network/timeout/transient failure where
 * the caller should keep the URL but skip the size + gated branches. */
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
  const downloadUrl = buildResolveUrl(parsed);
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
