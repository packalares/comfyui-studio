// Resolve a user-supplied HuggingFace or CivitAI URL into the catalog and
// stamp the resolution onto the staged workflow.
//
// Used by `POST /templates/import/staging/:id/resolve-model`. The review
// step of the import modal lets the user paste a URL next to any missing
// model row; this module takes care of:
//
//   1. Routing to the correct resolver based on the URL's host.
//   2. Upserting a catalog row so the next import that references the
//      same filename auto-resolves without the user repeating themselves.
//   3. Updating the staged workflow's `resolvedModels` map + `modelUrls`
//      so the frontend can re-render the row in its "resolved" state.
//
// Error shape: a thrown `ResolverError` carries a structured `code` the
// route maps to 400 (UNSUPPORTED_HOST) / 422 (RESOLVER_FAILED). No bare
// strings, no "500 internal error" surprises.

import * as catalog from '../catalog.js';
import { formatBytes } from '../../lib/format.js';
import { resolveHuggingfaceUrl, type ResolvedModel } from '../models/resolveHuggingface.js';
import { resolveCivitaiUrl } from '../models/resolveCivitai.js';
import { folderForLoaderClass } from '../workflow/loaderFolders.js';
import { getStaging } from './importStaging.js';

export type ResolverErrorCode = 'UNSUPPORTED_HOST' | 'RESOLVER_FAILED' | 'STAGING_NOT_FOUND' | 'WORKFLOW_INDEX_OUT_OF_RANGE';

export class ResolverError extends Error {
  readonly code: ResolverErrorCode;
  constructor(code: ResolverErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function hostOf(raw: string): string {
  try { return new URL(raw).hostname.toLowerCase(); }
  catch { return ''; }
}

function isHfUrl(raw: string): boolean {
  const h = hostOf(raw);
  return h === 'huggingface.co' || h === 'www.huggingface.co';
}

function isCivitaiUrl(raw: string): boolean {
  const h = hostOf(raw);
  return h === 'civitai.com' || h === 'www.civitai.com';
}

async function runResolver(url: string): Promise<ResolvedModel | null> {
  if (isHfUrl(url)) return resolveHuggingfaceUrl(url);
  if (isCivitaiUrl(url)) return resolveCivitaiUrl(url);
  throw new ResolverError('UNSUPPORTED_HOST',
    'Only HuggingFace and CivitAI URLs are supported. Other sources must be added manually.');
}

/**
 * Upsert a catalog row from the resolver's output. We key on the target
 * filename (same as the rest of the catalog) so the "install" button on
 * the Required Models card flips to "ready to download" without another
 * round trip. `save_path` is seeded from the resolver's folder guess when
 * available; otherwise we let the existing mergeMissingInto guard leave
 * whatever the catalog already had.
 */
function upsertFromResolved(
  resolved: ResolvedModel,
  targetFileName: string,
  loaderClass?: string,
): void {
  // Loader-class wins over URL-side guess: the workflow node that uses
  // the file is unambiguous about which `models/<folder>/` directory
  // ComfyUI will read from, while `resolved.suggestedFolder` can only
  // see the URL. Without this, files referenced by
  // `LatentUpscaleModelLoader` got written as `upscale_models` (wrong)
  // and text-encoder weights for `LTXAVTextEncoderLoader` defaulted to
  // `checkpoints` via the ext fallback.
  const folder = folderForLoaderClass(loaderClass)
    || resolved.suggestedFolder
    || 'checkpoints';
  const sizeBytes = typeof resolved.sizeBytes === 'number' ? resolved.sizeBytes : undefined;
  catalog.upsertModel({
    filename: targetFileName,
    name: targetFileName,
    type: folder,
    save_path: folder,
    url: resolved.downloadUrl,
    size_bytes: sizeBytes,
    size_pretty: typeof sizeBytes === 'number' ? formatBytes(sizeBytes) : undefined,
    size_fetched_at: typeof sizeBytes === 'number' ? new Date().toISOString() : null,
    source: `user-override:${resolved.source}`,
  });
}

export interface ResolveModelInput {
  stagingId: string;
  workflowIndex: number;
  missingFileName: string;
  url: string;
}

export interface ResolveModelResult {
  resolved: ResolvedModel;
  /** The target filename — same as `input.missingFileName` for convenience. */
  fileName: string;
}

/**
 * End-to-end resolver: look up the staged workflow, run the host-specific
 * resolver, upsert the catalog, and persist the resolution on the staging
 * row so subsequent GETs return the updated state. Throws `ResolverError`
 * with a typed code so the route layer can map it to a useful HTTP code.
 */
export async function resolveModelForStaging(
  input: ResolveModelInput,
): Promise<ResolveModelResult> {
  const staged = getStaging(input.stagingId);
  if (!staged) throw new ResolverError('STAGING_NOT_FOUND', 'Staging not found or expired.');
  const wf = staged.workflows[input.workflowIndex];
  if (!wf) throw new ResolverError('WORKFLOW_INDEX_OUT_OF_RANGE', 'workflowIndex out of range.');
  const resolved = await runResolver(input.url);
  if (!resolved) {
    throw new ResolverError('RESOLVER_FAILED',
      'Could not resolve a downloadable file from that URL. Try a blob/resolve link pointing directly at the file.');
  }
  // Use the filename the user flagged as missing — the resolver's own
  // filename may differ when the URL points at a mirror or a versioned
  // tarball, and we need the catalog key to match the workflow's widget.
  const fileName = input.missingFileName || resolved.fileName;
  const loaderClass = wf.modelLoaderClasses?.[fileName];
  upsertFromResolved(resolved, fileName, loaderClass);
  if (!wf.resolvedModels) wf.resolvedModels = {};
  wf.resolvedModels[fileName] = {
    downloadUrl: resolved.downloadUrl,
    source: resolved.source as 'huggingface' | 'civitai',
    suggestedFolder: folderForLoaderClass(loaderClass) || resolved.suggestedFolder,
    sizeBytes: resolved.sizeBytes,
  };
  if (!wf.modelUrls.includes(input.url)) wf.modelUrls = [...wf.modelUrls, input.url];
  return { resolved, fileName };
}
