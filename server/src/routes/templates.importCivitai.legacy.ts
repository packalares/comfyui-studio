// Legacy versionId-based CivitAI import handler.
//
// Kept separate so the main `templates.importCivitai.ts` stays under the
// structure-test line cap. Called by `CivitaiTemplateCard` on the Explore
// page via POST /templates/import-civitai.
//
// Flow: resolve version -> fetch primary file -> stage (JSON single-workflow
// via stageFromJson, ZIP multi-workflow via stageFromZip). Always returns a
// staged manifest so the Explore card opens the review modal for selection.
// Thumbnails + tags + description from the CivitAI model are threaded through
// as staging defaults so the committed user template carries them.

import type { Request, Response } from 'express';
import * as templates from '../services/templates/index.js';
import * as settings from '../services/settings.js';
import * as civitai from '../services/civitai/civitai.service.js';
import { fetchWithRetry, getCivitaiAuthHeaders } from '../lib/http.js';
import { env } from '../config/env.js';
import { sendError } from '../middleware/errors.js';

const ZIP_MAX_BYTES = 20 * 1024 * 1024;

function resolveVersionId(body: unknown): string {
  const b = (body || {}) as { workflowVersionId?: string | number };
  const raw = b.workflowVersionId;
  return raw != null ? String(raw) : '';
}

const looksLikeLitegraph = templates.looksLikeLitegraph;

async function fetchRemoteBytes(
  url: string,
  maxBytes: number,
  extraHeaders: Record<string, string>,
): Promise<ArrayBuffer> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: extraHeaders,
    });
    if (!res.ok) throw new Error(`upstream ${res.status} ${res.statusText}`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxBytes) {
      throw new Error(`payload too large: ${buf.byteLength} > ${maxBytes}`);
    }
    return buf;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Pull extras off /models/:id that aren't exposed on /model-versions/:id:
 * first image url (thumbnail), tags, description. Silent on failure — the
 * import still works without them.
 */
async function fetchModelExtras(
  modelId: number | null,
  versionId: string,
): Promise<{ thumbnail?: string; tags: string[]; description?: string }> {
  if (!modelId) return { tags: [] };
  try {
    const raw = (await civitai.getModelDetails(String(modelId))) as {
      description?: string | null;
      tags?: unknown;
      modelVersions?: Array<{ id?: number; images?: Array<{ url?: string; type?: string }> }>;
    };
    const versions = Array.isArray(raw.modelVersions) ? raw.modelVersions : [];
    const match = versions.find((v) => String(v.id) === versionId) ?? versions[0];
    const images = Array.isArray(match?.images) ? match.images : [];
    const firstImage = images.find((i) => i && (i.type === 'image' || !i.type) && typeof i.url === 'string');
    const rawTags = Array.isArray(raw.tags) ? raw.tags : [];
    const tags: string[] = [];
    for (const t of rawTags) {
      if (typeof t === 'string' && t.trim()) tags.push(t.trim());
      else if (t && typeof t === 'object') {
        const n = (t as { name?: unknown }).name;
        if (typeof n === 'string' && n.trim()) tags.push(n.trim());
      }
    }
    const desc = typeof raw.description === 'string' ? raw.description.trim() : '';
    return {
      thumbnail: firstImage?.url,
      tags,
      description: desc.length > 0 ? (desc.length > 2000 ? `${desc.slice(0, 2000)}…` : desc) : undefined,
    };
  } catch {
    return { tags: [] };
  }
}

/**
 * Flow:
 *   1. Resolve version via `/api/v1/model-versions/:id`.
 *   2. Fetch model extras (thumbnail, tags, description).
 *   3. Stage: JSON file -> stageFromJson; ZIP -> stageFromZip.
 *   4. Attach civitaiMeta + return the manifest. Always staged — the Explore
 *      card opens the review modal for user selection.
 */
export async function handleImportCivitai(req: Request, res: Response): Promise<void> {
  try {
    const versionId = resolveVersionId(req.body);
    if (!versionId) {
      res.status(400).json({ error: 'workflowVersionId is required' });
      return;
    }

    const meta = await civitai.getWorkflowVersionFile(versionId);
    const civitaiToken = settings.getCivitaiToken();
    const authHeaders = getCivitaiAuthHeaders(meta.downloadUrl, civitaiToken);
    const extras = await fetchModelExtras(meta.modelId, versionId);
    const sourceUrl = `https://civitai.com/models/${meta.modelId ?? ''}?modelVersionId=${versionId}`;
    const defaultTitle = meta.modelName || `CivitAI Workflow ${versionId}`;
    const defaultDescription = extras.description
      ?? `Imported from civitai.com (model version ${versionId}).`;
    const civitaiMeta = meta.modelId != null
      ? {
        modelId: meta.modelId,
        tags: extras.tags.length > 0 ? extras.tags : undefined,
        description: extras.description,
        originalUrl: sourceUrl,
      }
      : undefined;

    let staged;
    if (meta.isJsonFile) {
      const fetched = await fetchWithRetry(meta.downloadUrl, {
        attempts: 3,
        baseDelayMs: 500,
        timeoutMs: 30_000,
        maxBytes: env.CIVITAI_MAX_RESPONSE_BYTES,
        headers: { Accept: 'application/json', ...authHeaders },
      });
      let parsed: unknown;
      try { parsed = JSON.parse(fetched.text); }
      catch (err) {
        res.status(400).json({
          error: `Workflow file was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }
      if (!looksLikeLitegraph(parsed)) {
        res.status(400).json({
          error: 'Workflow JSON has no top-level `nodes` array; not a LiteGraph document.',
        });
        return;
      }
      staged = await templates.stageFromJson(parsed as Record<string, unknown>, {
        source: 'civitai',
        sourceUrl,
        entryName: meta.fileName,
        defaultTitle,
        defaultDescription,
        defaultTags: extras.tags.length > 0 ? extras.tags : undefined,
        defaultThumbnail: extras.thumbnail,
      });
    } else {
      const isZip = meta.type === 'Archive' || /\.zip$/i.test(meta.fileName ?? '');
      if (!isZip) {
        res.status(415).json({
          error: 'Unsupported workflow file type.',
          fileName: meta.fileName,
          type: meta.type,
        });
        return;
      }
      let zipBytes: ArrayBuffer;
      try {
        zipBytes = await fetchRemoteBytes(meta.downloadUrl, ZIP_MAX_BYTES, {
          Accept: 'application/octet-stream',
          ...authHeaders,
        });
      } catch (err) {
        res.status(502).json({
          error: `Failed to download zip: ${err instanceof Error ? err.message : String(err)}`,
          fileName: meta.fileName,
        });
        return;
      }
      try {
        staged = await templates.stageFromZip(zipBytes, {
          source: 'civitai',
          sourceUrl,
          defaultTitle,
          defaultDescription,
          defaultTags: extras.tags.length > 0 ? extras.tags : undefined,
          defaultThumbnail: extras.thumbnail,
        });
      } catch (err) {
        res.status(400).json({
          error: `Zip archive could not be opened: ${err instanceof Error ? err.message : String(err)}`,
          fileName: meta.fileName,
        });
        return;
      }
      if (staged.workflows.length === 0) {
        res.status(415).json({
          error: 'No LiteGraph workflow JSON found inside the zip.',
          fileName: meta.fileName,
        });
        return;
      }
    }

    if (civitaiMeta) staged.civitaiMeta = civitaiMeta;
    res.json({ staged: true, manifest: templates.toManifest(staged) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Missing workflow version ID|not valid JSON|no top-level|nodes array/.test(msg)) {
      res.status(400).json({ error: msg });
      return;
    }
    sendError(res, err, 502, 'Workflow import failed');
  }
}

/**
 * DELETE /templates/:name — removes a user-imported workflow. Upstream
 * ComfyUI templates cannot be removed (403).
 */
export function handleDeleteTemplate(req: Request, res: Response): void {
  const name = req.params.name as string;
  if (!templates.isUserWorkflow(name)) {
    res.status(403).json({ error: 'Only user-imported templates can be deleted' });
    return;
  }
  const removed = templates.deleteUserWorkflow(name);
  if (!removed) {
    res.status(404).json({ error: `Template not found: ${name}` });
    return;
  }
  templates.loadTemplatesFromComfyUI(env.COMFYUI_URL).catch(() => { /* best effort */ });
  res.json({ deleted: true, name });
}
