// Commit path for a staged import: persist chosen workflows via
// `saveUserWorkflow` and (optionally) copy reference images into ComfyUI's
// input/ directory.
//
// Every write goes through `safeResolve(COMFYUI_PATH, 'input')` so a
// crafted image filename cannot escape the input root.

import fs from 'fs';
import { safeResolve } from '../../lib/fs.js';
import { logger } from '../../lib/logger.js';
import { extractDeps } from './depExtract.js';
import { resolutionsToRepoKeys } from './extractDepsAsync.js';
import { canonicalize, dedupKey } from '../plugins/nodes.js';
import { extractWorkflowIo, deriveMediaType, mediaTypeToStudioCategory } from './metadata.js';
import fsPath from 'path';
import { paths } from '../../config/paths.js';
import { saveUserWorkflow, slugifyTemplateName } from './userTemplates.js';
import { consumeStaging, getStaging, type StagedImport, type StagedWorkflowEntry } from './importStaging.js';
import { rewriteLoadImageReferences } from './rewriteLoadImage.js';
import { WorkflowNameCollisionError } from './errors.js';
import type { TemplatePluginEntry } from './types.js';

export interface CommitSelection {
  /** Indices into `staged.workflows` to import. */
  workflowIndices: number[];
  /** When true, reference images are copied into `${COMFYUI_PATH}/input/`. */
  imagesCopy: boolean;
  /**
   * Per-index title override. Used by the "Use suggested name" retry after a
   * `WorkflowNameCollisionError` — the UI re-submits commit with the
   * suggested slug here so the second attempt lands at a free slot.
   */
  titleOverrides?: Record<number, string>;
}

export interface CommitResult {
  imported: string[];
  imagesCopied: string[];
}

/**
 * Wave L: thrown when one or more selected workflows still have unresolved
 * deps. The route layer maps this to 409 Conflict with `unresolvedModels` +
 * `unresolvedPlugins` arrays so the UI can surface the exact blocking rows.
 */
export class CommitBlockedError extends Error {
  readonly unresolvedModels: string[];
  readonly unresolvedPlugins: string[];
  constructor(unresolvedModels: string[], unresolvedPlugins: string[]) {
    super('Import blocked: unresolved dependencies.');
    this.unresolvedModels = unresolvedModels;
    this.unresolvedPlugins = unresolvedPlugins;
    this.name = 'CommitBlockedError';
  }
}

/**
 * Validate that every selected workflow's models are resolved. A model is
 * "covered" by `resolvedModels` (user-paste) or `autoResolvedModels`
 * (staging-time auto-resolve). Missing models block — they'd cause an
 * unrecoverable Studio runtime error. Plugins are NOT blocking: Manager is
 * often offline and legacy saves carry no aux_id, both of which yield empty
 * resolver matches even when the plugin is installed.
 */
export function validateCommitReady(
  staged: StagedImport, indices: number[],
): void {
  const unresolvedModels = new Set<string>();
  for (const idx of indices) {
    const wf: StagedWorkflowEntry | undefined = staged.workflows[idx];
    if (!wf) continue;
    const covered = new Set<string>();
    for (const fn of Object.keys(wf.resolvedModels ?? {})) covered.add(fn);
    for (const fn of Object.keys(wf.autoResolvedModels ?? {})) covered.add(fn);
    for (const fn of wf.models ?? []) {
      if (!covered.has(fn)) unresolvedModels.add(fn);
    }
  }
  if (unresolvedModels.size === 0) return;
  throw new CommitBlockedError(Array.from(unresolvedModels).sort(), []);
}

function inputDir(): string {
  // Re-resolve through safeResolve so existing trust-boundary checks
  // (`safeResolve` rejects path traversal) still apply.
  return safeResolve(paths.comfyInputDir);
}

// Bounded loop so a degenerate collection of past imports can't lock the
// search. Same shape as `nextAvailableSlug` inside userTemplates.ts.
function suggestSlugSlot(slug: string): string {
  for (let i = 2; i <= 500; i += 1) {
    const cand = fsPath.join(paths.userTemplatesDir, `${slug}-${i}.json`);
    if (!fs.existsSync(cand)) return `${slug}-${i}`;
  }
  return `${slug}-501`;
}

function copyImagesFor(staged: StagedImport, slug: string, imagesCopy: boolean): string[] {
  if (!imagesCopy || staged.images.length === 0) return [];
  const copied: string[] = [];
  let root: string;
  try { root = inputDir(); }
  catch (err) {
    logger.warn('import commit: input dir unavailable', { error: String(err) });
    return [];
  }
  try { fs.mkdirSync(root, { recursive: true }); } catch { /* best effort */ }
  for (const img of staged.images) {
    const outName = `${slug}__${img.name}`;
    let target: string;
    try { target = safeResolve(root, outName); } catch { continue; }
    try {
      fs.writeFileSync(target, Buffer.from(img.bytes), { mode: 0o644 });
      copied.push(outName);
    } catch (err) {
      logger.warn('import commit: image copy failed', { name: outName, error: String(err) });
    }
  }
  return copied;
}

/**
 * Commit the chosen workflows + images. The staged row is consumed (removed)
 * even on partial success — the frontend should re-stage if the user needs to
 * retry, since image bytes are dropped along with the row.
 */
export async function commitStaging(id: string, selection: CommitSelection): Promise<CommitResult> {
  // Peek the staging row first so we can throw a typed CommitBlockedError
  // BEFORE consuming it. If validation passes we consume + commit; on
  // block we leave the row in place so the user can resolve the missing
  // rows and retry without re-uploading the zip.
  const peek = getStaging(id);
  if (!peek) throw new Error('Staging not found or expired');
  validateCommitReady(peek, selection.workflowIndices);
  // Pre-flight slug collision check — runs before we consume the staging
  // row so the user can rename + retry without re-uploading. The first
  // colliding slug throws; the route layer maps that to a 409 + the
  // suggested fallback slug for one-click retry. `titleOverrides` lets the
  // retry submit a fresh title for any colliding index in the same call.
  const overrides = selection.titleOverrides ?? {};
  for (const idx of selection.workflowIndices) {
    const wf = peek.workflows[idx];
    if (!wf) continue;
    const effectiveTitle = overrides[idx] || wf.title || wf.entryName;
    const slug = slugifyTemplateName(effectiveTitle);
    const target = fsPath.join(paths.userTemplatesDir, `${slug}.json`);
    if (fs.existsSync(target)) {
      throw new WorkflowNameCollisionError(slug, suggestSlugSlot(slug), idx);
    }
  }

  const staged = consumeStaging(id);
  if (!staged) throw new Error('Staging not found or expired');

  const imported: string[] = [];
  const imagesCopied: string[] = [];
  const thumbnails = staged.defaultThumbnail ? [staged.defaultThumbnail] : [];
  const alreadyCopied = new Set<string>();

  for (const idx of selection.workflowIndices) {
    const wf = staged.workflows[idx];
    if (!wf) continue;
    // Apply the per-index title override (collision retry) before slugging.
    const effectiveTitle = overrides[idx] || wf.title || wf.entryName;
    const tentativeSlug = slugifyTemplateName(effectiveTitle);
    // Image rename map only built when actually copying images — without a
    // copy the workflow must keep pointing at the original filenames. The
    // `copyImagesFor` helper uses the same `<slug>__<name>` policy.
    const renameMap: Record<string, string> = {};
    if (selection.imagesCopy && staged.images.length > 0) {
      for (const img of staged.images) {
        renameMap[img.name] = `${tentativeSlug}__${img.name}`;
      }
    }
    const rewrittenWorkflow = Object.keys(renameMap).length > 0
      ? (rewriteLoadImageReferences(wf.workflow, renameMap) as Record<string, unknown>)
      : wf.workflow;
    const io = extractWorkflowIo(rewrittenWorkflow);
    const mediaType = deriveMediaType(io);
    const studioCat = mediaTypeToStudioCategory(mediaType);
    const deps = extractDeps(rewrittenWorkflow);
    // Pre-warm the canonical-id cache for every match's repo so the dedup
    // loop's `dedupKey` reads from cache rather than racing CNR fetches.
    const refs = new Set<string>();
    for (const r of wf.plugins) for (const m of r.matches) refs.add(m.repo);
    await Promise.all(Array.from(refs).map((r) => canonicalize(r)));
    // Canonical-keyed dedup: rows with `comfyui-reactor` (cnr_id) and
    // `gourieff/comfyui-reactor` (aux_id) collapse to one entry. The
    // slashed (owner/repo) form wins as the surviving entry — it's the
    // valid GitHub URL the install button uses.
    const pluginByCanonical = new Map<string, TemplatePluginEntry>();
    for (const r of wf.plugins) {
      for (const m of r.matches) {
        const dk = dedupKey(m.repo);
        const existing = pluginByCanonical.get(dk);
        const next: TemplatePluginEntry = {
          repo: m.repo, title: m.title, cnr_id: m.cnr_id,
        };
        if (!existing) {
          pluginByCanonical.set(dk, next);
        } else if (m.repo.includes('/') && !existing.repo.includes('/')) {
          // Promote slashed form over bare cnr_id, but preserve the
          // existing cnr_id metadata (the cnr_id is useful for the
          // catalog lookup even when the slashed form is canonical).
          pluginByCanonical.set(dk, {
            ...next,
            cnr_id: next.cnr_id ?? existing.cnr_id,
          });
        } else if (!existing.cnr_id && next.cnr_id) {
          // Existing kept the slashed form but had no cnr_id; backfill it.
          pluginByCanonical.set(dk, { ...existing, cnr_id: next.cnr_id });
        }
      }
    }
    const pluginEntries: TemplatePluginEntry[] = Array.from(pluginByCanonical.values());
    const pluginRepoKeys = resolutionsToRepoKeys(wf.plugins);
    // Easy-mode metadata (studioBuilder / studioModes / promptEnhancer) is
    // harvested by `extractLitegraph` from the outer TemplateData wrapper at
    // upload time and rides on the StagedWorkflowEntry. We just forward it
    // here — no parallel pluck against the inner workflow.
    type BuilderMeta = Pick<
      Parameters<typeof saveUserWorkflow>[0],
      'studioBuilder' | 'studioModes' | 'studioInputMap' | 'studioAlwaysActiveGroups' | 'promptEnhancer' | 'prompt_toggles'
    >;
    const builderMeta: BuilderMeta = {};
    if (wf.studioBuilder !== undefined) {
      builderMeta.studioBuilder = wf.studioBuilder as BuilderMeta['studioBuilder'];
    }
    if (wf.studioModes !== undefined) {
      builderMeta.studioModes = wf.studioModes as BuilderMeta['studioModes'];
    }
    if (wf.studioInputMap !== undefined) {
      builderMeta.studioInputMap = wf.studioInputMap;
    }
    if (wf.studioAlwaysActiveGroups !== undefined) {
      builderMeta.studioAlwaysActiveGroups = wf.studioAlwaysActiveGroups;
    }
    if (wf.promptEnhancer !== undefined) {
      builderMeta.promptEnhancer = wf.promptEnhancer as BuilderMeta['promptEnhancer'];
    }
    if (wf.prompt_toggles !== undefined) {
      builderMeta.prompt_toggles = wf.prompt_toggles as BuilderMeta['prompt_toggles'];
    }
    const saved = saveUserWorkflow({
      name: effectiveTitle,
      title: effectiveTitle,
      description: wf.description ?? staged.defaultDescription ?? '',
      workflow: rewrittenWorkflow,
      sourceUrl: staged.sourceUrl,
      tags: staged.defaultTags,
      io,
      mediaType,
      studioCategory: studioCat,
      models: deps.models,
      plugins: pluginEntries,
      thumbnail: thumbnails,
      civitaiMeta: staged.civitaiMeta,
      ...builderMeta,
    });
    imported.push(saved.name);
    // Persist template_plugins edges so readiness + install-missing-plugins
    // can find them. Lazy import keeps this file cheap in staging-only tests.
    // Existing branch preserves prior source/workflow_json/installed so an
    // upstream->user rename doesn't reset readiness; new branch inserts a
    // full row for user-imported workflows.
    try {
      const repo = await import('../../lib/db/templates.repo.js');
      const existing = repo.getTemplate(saved.name);
      // Determine source_type based on staged import source.
      let sourceType = repo.SOURCE_UPLOAD;
      if (staged.sourceUrl) {
        if (/civitai\.com/i.test(staged.sourceUrl)) sourceType = repo.SOURCE_CIVITAI;
        else if (/github\.com/i.test(staged.sourceUrl)) sourceType = repo.SOURCE_GITHUB;
      }
      // Build thumbnail_json from the staged default thumbnail if available.
      const thumbJson = thumbnails.length > 0
        ? JSON.stringify(thumbnails)
        : (Array.isArray(saved.thumbnail) && saved.thumbnail.length > 0
          ? JSON.stringify(saved.thumbnail)
          : null);
      repo.upsertTemplate(
        {
          name: saved.name,
          displayName: existing?.displayName ?? saved.title ?? saved.name,
          category: existing?.category ?? saved.category ?? null,
          description: existing?.description ?? saved.description ?? null,
          tags_json: existing?.tags_json ?? JSON.stringify(saved.tags ?? []),
          installed: existing?.installed ?? false,
          source_type: existing?.source_type ?? sourceType,
          media_type: existing?.media_type ?? (typeof saved.mediaType === 'string' ? saved.mediaType : null),
          open_source: existing?.open_source ?? 1,
          search_rank: existing?.search_rank ?? 0,
          username: existing?.username ?? null,
          thumbnail_json: existing?.thumbnail_json ?? thumbJson,
        },
        { models: deps.models, plugins: pluginRepoKeys },
      );
      // Compute readiness immediately so the freshly-imported template
      // shows the correct ready/not-ready badge in Explore. Without this
      // the row stays at `installed: false` until either a plugin/model
      // install event fires OR the next /refresh-templates pass — which
      // for templates whose deps are already satisfied means "never until
      // boot" if the user just imported them and didn't trigger any
      // installs.
      const { recomputeTemplateReadiness } = await import('./dependencyCheck.js');
      await recomputeTemplateReadiness([saved.name]);
    } catch (err) {
      logger.warn('import commit: template_plugins edge write skipped', {
        name: saved.name, error: err instanceof Error ? err.message : String(err),
      });
    }

    // Easy-mode template_presets[] persistence — only fires when the import
    // payload had both `studioBuilder` set AND a `template_presets` array.
    // Downloads previews into `<userTemplatesDir>/<saved.name>/` and writes
    // the display-card array to the `template_presets` column. Best-effort:
    // any per-preset failure is logged and that one is dropped; the rest of
    // the import keeps going.
    if (wf.studioBuilder && Array.isArray(wf.template_presets) && wf.template_presets.length > 0) {
      try {
        const { persistTemplatePresets } = await import('./presetsImport.js');
        const persisted = await persistTemplatePresets(saved.name, wf.template_presets);
        logger.info('import commit: presets persisted', {
          name: saved.name, count: persisted, supplied: wf.template_presets.length,
        });
      } catch (err) {
        logger.warn('import commit: presets persistence failed', {
          name: saved.name, error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const slug = slugifyTemplateName(saved.name);
    const copiedForThis = copyImagesFor(staged, slug, selection.imagesCopy);
    for (const c of copiedForThis) {
      if (!alreadyCopied.has(c)) {
        alreadyCopied.add(c);
        imagesCopied.push(c);
      }
    }
  }

  return { imported, imagesCopied };
}
