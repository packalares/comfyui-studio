// CivitAI URL -> staged workflow pipeline (Wave J).
//
// Accepts one of three CivitAI URL shapes the user would naturally paste:
//   https://civitai.com/models/<modelId>[/<slug>]
//   https://civitai.com/models/<modelId>?modelVersionId=<versionId>
//   https://civitai.com/api/download/models/<versionId>
//
// Flow:
//   1. Parse URL via `parseCivitaiTemplateUrl`.
//   2. Fetch the model (or version) JSON via civitai's REST API.
//   3. Walk every modelVersion's `files[]`; if any entry is classified as
//      a Workflow (`type === 'Workflow'`) OR its filename ends in `.json`,
//      download the JSON and feed it through `stageFromJson`.
//   4. Fallback: walk every modelVersion's `images[]`; if any image has
//      `meta.workflow`, feed that through `stageFromJson`.
//   5. Attach `civitaiMeta` to the staged row so commit can persist it.
//
// URL parsing + typed errors live in `importCivitaiTemplate.urls.ts`.
// HTTP + workflow-discovery helpers live in `importCivitaiTemplate.fetch.ts`.

import { logger } from '../../lib/logger.js';
import * as civitai from '../civitai/civitai.service.js';
import { stageFromJson } from './importZip.js';
import type { StagedImport, StagedCivitaiMeta } from './importStaging.js';
import {
  parseCivitaiTemplateUrl,
  ImportCivitaiError,
} from './importCivitaiTemplate.urls.js';
import {
  findWorkflow,
  normaliseTags,
  trimDescription,
  type CivitaiModelVersion,
} from './importCivitaiTemplate.fetch.js';

export { parseCivitaiTemplateUrl, ImportCivitaiError };
export type { ImportCivitaiErrorCode, CivitaiUrlLocator } from './importCivitaiTemplate.urls.js';

/** Minimal shape we read off the civitai /models/:id response. */
interface CivitaiModelResponse {
  id?: number;
  name?: string;
  description?: string | null;
  tags?: unknown;
  modelVersions?: Array<CivitaiModelVersion>;
}

async function loadModel(modelId: number): Promise<CivitaiModelResponse> {
  try {
    return (await civitai.getModelDetails(String(modelId))) as CivitaiModelResponse;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/404/.test(msg)) {
      throw new ImportCivitaiError('UPSTREAM_NOT_FOUND', `CivitAI model ${modelId} not found`);
    }
    throw new ImportCivitaiError('UPSTREAM_FAILURE', msg);
  }
}

async function loadVersion(versionId: number): Promise<CivitaiModelVersion & { modelId?: number }> {
  try {
    return (await civitai.getModelDownloadInfo(String(versionId))) as CivitaiModelVersion
      & { modelId?: number };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/404/.test(msg)) {
      throw new ImportCivitaiError('UPSTREAM_NOT_FOUND', `CivitAI version ${versionId} not found`);
    }
    throw new ImportCivitaiError('UPSTREAM_FAILURE', msg);
  }
}

interface ResolvedContext {
  modelId: number;
  versions: CivitaiModelVersion[];
  displayName?: string;
  description?: string;
  tags: string[];
}

/** Pull the parent model (and optional narrowed version) into a single bundle. */
async function resolveContext(
  modelId: number | undefined,
  versionId: number | undefined,
): Promise<ResolvedContext> {
  const out: ResolvedContext = {
    modelId: modelId ?? 0,
    versions: [],
    tags: [],
  };
  if (modelId) {
    const info = await loadModel(modelId);
    out.modelId = typeof info.id === 'number' ? info.id : modelId;
    out.displayName = typeof info.name === 'string' ? info.name : undefined;
    out.description = trimDescription(info.description);
    out.tags = normaliseTags(info.tags);
    const versions = Array.isArray(info.modelVersions) ? info.modelVersions : [];
    if (versionId) {
      const match = versions.find((v) => v.id === versionId);
      out.versions = match ? [match] : versions;
    } else {
      out.versions = versions;
    }
  } else if (versionId) {
    const version = await loadVersion(versionId);
    if (typeof version.modelId === 'number') {
      out.modelId = version.modelId;
      try {
        const info = await loadModel(version.modelId);
        out.displayName = typeof info.name === 'string' ? info.name : undefined;
        out.description = trimDescription(info.description);
        out.tags = normaliseTags(info.tags);
      } catch (err) {
        logger.warn('civitai parent model lookup failed', {
          modelId: version.modelId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    out.versions = [version];
  }
  return out;
}

/**
 * Resolve `url` to a staged user workflow. Returns the staged import on
 * success and throws an `ImportCivitaiError` on any classified failure.
 */
export async function stageFromCivitaiUrl(url: string): Promise<StagedImport> {
  const locator = parseCivitaiTemplateUrl(url);
  if (!locator) {
    throw new ImportCivitaiError(
      'UNSUPPORTED_URL',
      'URL must match /models/<id>, /models/<id>?modelVersionId=<v>, or /api/download/models/<v>',
    );
  }
  const ctx = await resolveContext(locator.modelId, locator.versionId);
  if (ctx.versions.length === 0) {
    throw new ImportCivitaiError('NO_WORKFLOW_FOUND', 'No model versions found on CivitAI entry');
  }
  const candidate = await findWorkflow(ctx.versions);
  if (!candidate) {
    throw new ImportCivitaiError(
      'NO_WORKFLOW_FOUND',
      'This CivitAI model has no ComfyUI workflow attached: no .json file in files[] and no workflow embedded in image generation metadata (we also scanned /api/v1/images for each version). If you want to use just the model file, add it from Models → CivitAI instead.',
    );
  }

  const originalUrl = locator.versionId
    ? `https://civitai.com/models/${ctx.modelId}?modelVersionId=${locator.versionId}`
    : `https://civitai.com/models/${ctx.modelId}`;

  const civitaiMeta: StagedCivitaiMeta = { modelId: ctx.modelId };
  if (ctx.tags.length > 0) civitaiMeta.tags = ctx.tags;
  if (ctx.description) civitaiMeta.description = ctx.description;
  civitaiMeta.originalUrl = originalUrl;

  const staged = await stageFromJson(candidate.workflow, {
    source: 'civitai',
    sourceUrl: originalUrl,
    entryName: candidate.originFileName ?? `civitai-${ctx.modelId}.json`,
    defaultTitle: ctx.displayName,
    defaultDescription: ctx.description,
    defaultTags: ctx.tags,
  });
  staged.civitaiMeta = civitaiMeta;
  logger.info('civitai url staged', {
    modelId: ctx.modelId,
    source: candidate.source,
    bytes: candidate.bytes,
  });
  return staged;
}
