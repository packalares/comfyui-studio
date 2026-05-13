// Template catalog refresh.
//
// Re-pulls every template from ComfyUI, fetches each workflow's JSON, runs
// `extractDeps` to enumerate required models + plugins, and diff-upserts the
// result into the sqlite templates + dep-graph tables. Rows not in the fresh
// set are removed.
//
// Diff rules:
//   - added:     in fresh, not in sqlite.
//   - updated:   in both, but displayName / description / workflow_json /
//                tags_json / model-deps / plugin-deps changed.
//   - unchanged: in both, no material change.
//   - removed:   in sqlite, not in fresh.
//
// After upserts we recompute readiness for every upserted row in one
// catalog-snapshot pass so the `installed` flag is accurate on return.

import { logger } from '../../lib/logger.js';
import { env } from '../../config/env.js';
import * as templateRepo from '../../lib/db/templates.repo.js';
import { extractDeps } from './depExtract.js';
import { extractDepsWithPluginResolution, resolutionsToRepoKeys } from './extractDepsAsync.js';
import { loadTemplatesFromComfyUI, getTemplates } from './templates.service.js';
import { recomputeTemplateReadiness } from './dependencyCheck.js';
import { isUserWorkflow } from './userTemplates.js';
import type { TemplateData } from './types.js';

export interface RefreshResult {
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
  /** Present only when the refresh aborted before touching the DB. Lets the
   *  UI / caller distinguish "ComfyUI honestly has nothing" from "we never
   *  heard back so we did nothing". */
  skipped?: 'upstream-unreachable' | 'sanity-check';
}

interface ComputedEntry {
  name: string;
  row: templateRepo.TemplateRow;
  deps: templateRepo.TemplateDeps;
}

async function fetchWorkflow(name: string): Promise<unknown> {
  try {
    const url = `${env.COMFYUI_URL}/templates/${encodeURIComponent(name)}.json`;
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function stableStringify(value: unknown): string {
  // Deterministic stringification for diff comparison; sorts object keys so
  // logically-identical workflows compare equal.
  if (value == null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function hasChanged(
  prev: templateRepo.TemplateListRow,
  next: templateRepo.TemplateRow,
  deps: templateRepo.TemplateDeps,
): boolean {
  if (prev.displayName !== next.displayName) return true;
  if ((prev.description ?? null) !== (next.description ?? null)) return true;
  if ((prev.category ?? null) !== (next.category ?? null)) return true;
  if ((prev.source ?? null) !== (next.source ?? null)) return true;
  if ((prev.workflow_json ?? null) !== (next.workflow_json ?? null)) return true;
  if ((prev.tags_json ?? null) !== (next.tags_json ?? null)) return true;
  if (stableStringify([...prev.models].sort()) !== stableStringify([...deps.models].sort())) return true;
  if (stableStringify([...prev.plugins].sort()) !== stableStringify([...deps.plugins].sort())) return true;
  return false;
}

async function toRefreshRow(t: TemplateData, workflow: unknown): Promise<ComputedEntry> {
  // `extractDeps` produces real filenames; the index's `t.models` shorthand
  // returns family tags ("Qwen-Image-Edit", "Wan") that never match installed
  // files and would poison readiness. Drop the merge.
  //
  // Plugin edges: the full async extractor unions aux_id/cnr_id hits with
  // Manager-resolved class_type matches. `resolutionsToRepoKeys` collapses
  // the detailed match objects into the `owner/repo` string form stored in
  // `template_plugins` — readiness queries + install-missing use that form.
  // Manager-offline degrades to the aux_id cheap path automatically.
  let pluginRepoKeys: string[];
  try {
    const resolved = await extractDepsWithPluginResolution(workflow);
    pluginRepoKeys = resolutionsToRepoKeys(resolved.plugins);
  } catch (err) {
    logger.warn('template refresh: plugin resolution failed', {
      name: t.name, error: err instanceof Error ? err.message : String(err),
    });
    pluginRepoKeys = extractDeps(workflow).plugins;
  }
  const cheap = extractDeps(workflow);
  const deps = { models: cheap.models, plugins: pluginRepoKeys };
  return {
    name: t.name,
    row: {
      name: t.name,
      displayName: t.title || t.name,
      category: t.category ?? null,
      description: t.description ?? null,
      source: t.openSource === false ? 'api' : 'open',
      workflow_json: workflow ? JSON.stringify(workflow) : null,
      tags_json: JSON.stringify(t.tags ?? []),
      installed: false,
    },
    deps,
  };
}

/**
 * Force-refresh the sqlite template catalog from ComfyUI and recompute the
 * readiness flag for every upserted row. Returns a diff summary.
 */
export async function refreshTemplates(): Promise<RefreshResult> {
  logger.info('template refresh: pulling fresh catalog from ComfyUI');
  const upstreamOk = await loadTemplatesFromComfyUI(env.COMFYUI_URL);
  if (!upstreamOk) {
    // Critical: if the upstream fetch failed, the in-memory cache is stale or
    // empty. Running the remove loop below would treat "ComfyUI didn't
    // answer" as "ComfyUI has no templates" and delete every upstream row in
    // sqlite — taking user pins / favorites with them. Bail out cleanly and
    // leave the DB exactly as it was; the next successful refresh repairs.
    logger.warn('template refresh skipped: upstream unreachable; DB left untouched');
    return { added: 0, updated: 0, unchanged: 0, removed: 0, skipped: 'upstream-unreachable' };
  }
  // User workflows live only in the in-memory cache + their JSON files on
  // disk; they must NOT flow through the sqlite upsert path (which would
  // overwrite their bundled workflow with a failed `/templates/:name.json`
  // 404 from ComfyUI). Filter them out before computing the diff.
  const all = getTemplates();
  const fresh = all.filter((t) => !isUserWorkflow(t.name));
  const freshNames = new Set(fresh.map((t) => t.name));

  // Fetch each workflow with a modest concurrency so we don't hammer ComfyUI.
  const computed: ComputedEntry[] = [];
  const CONCURRENCY = 6;
  let idx = 0;
  async function worker(): Promise<void> {
    while (idx < fresh.length) {
      const my = idx++;
      const t = fresh[my];
      const wf = await fetchWorkflow(t.name);
      computed.push(await toRefreshRow(t, wf));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, fresh.length) }, worker));

  let added = 0;
  let updated = 0;
  let unchanged = 0;
  for (const entry of computed) {
    const prev = templateRepo.getTemplate(entry.name);
    if (!prev) {
      templateRepo.upsertTemplate(entry.row, entry.deps);
      added++;
    } else if (hasChanged(prev, entry.row, entry.deps)) {
      templateRepo.upsertTemplate(entry.row, entry.deps);
      updated++;
    } else {
      unchanged++;
    }
  }

  // Remove templates that dropped out of the upstream index. Skip user-
  // imported workflows entirely — they live in `~/.config/comfyui-studio/
  // user-workflows/`, NOT in ComfyUI's `/templates/index.json`, so they
  // would always look like "dropped out" if we didn't exempt them.
  // Without this guard, every refresh deletes the user's imports along
  // with their readiness flag — making them appear "not ready" forever
  // until the next import recreates the row.
  //
  // Sanity check: if the fresh upstream count has collapsed to less than
  // half the currently-stored upstream count, treat the response as a
  // partial read (HTTP 200 but truncated JSON, etc.) and skip the delete
  // pass — but keep the upserts above since those are additive. Better to
  // leave a few stale rows than risk wiping user favorites on a bad fetch.
  const storedNames = templateRepo.listAllNames();
  const storedUpstream = storedNames.filter((n) => !isUserWorkflow(n)).length;
  const suspiciousShrink = storedUpstream > 0 && fresh.length < storedUpstream * 0.5;
  let removed = 0;
  if (suspiciousShrink) {
    logger.warn('template refresh: fresh upstream count suspiciously low; skipping delete pass', {
      stored: storedUpstream, fresh: fresh.length,
    });
  } else {
    for (const name of storedNames) {
      if (freshNames.has(name)) continue;
      if (isUserWorkflow(name)) continue;
      templateRepo.deleteTemplate(name);
      removed++;
    }
  }

  // Recompute readiness for everything we touched so the `installed` flag
  // tracks the post-refresh state. Include user workflows too — their deps
  // could have shifted since their last recompute (a plugin install they
  // were waiting on might have just landed).
  const userNames = all
    .filter((t) => isUserWorkflow(t.name))
    .map((t) => t.name);
  try {
    await recomputeTemplateReadiness([...computed.map((c) => c.name), ...userNames]);
  } catch (err) {
    logger.warn('refresh readiness recompute failed', { error: String(err) });
  }

  logger.info('template refresh complete', { added, updated, unchanged, removed });
  return {
    added, updated, unchanged, removed,
    ...(suspiciousShrink ? { skipped: 'sanity-check' as const } : {}),
  };
}
