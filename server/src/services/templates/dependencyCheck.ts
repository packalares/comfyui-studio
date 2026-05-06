// Single source of truth for "is this template ready to run?".
//
// `checkTemplateDependencies(name)` walks the template's workflow JSON,
// extracts every required model filename + plugin class_type, cross-
// references against the installed-models scan / `model_files` index /
// installed-plugin keys, and returns the union as `required[]` plus the
// not-yet-installed subset as `missing[]`. `ready` is `missing.length === 0`.
//
// Both consumers (HTTP route `POST /api/check-dependencies` and the chat
// `generate_image` tool's execute-time gate) import this directly — there
// is no HTTP self-call. The cached `templates.installed` column is also
// populated from the same function (see `templates/refresh.ts` etc.).

import * as catalog from '../catalog.js';
import { isUserWorkflow, getUserWorkflowJson } from './userTemplates.js';
import * as templateRepo from '../../lib/db/templates.repo.js';
import { collectAllWorkflowNodes } from '../workflow/collect.js';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import type {
  RequiredItem,
  RequiredModelInfo,
} from '../../contracts/generation.contract.js';
import {
  collectRequirements,
  refreshStaleEntries,
  fetchInstalledModels,
  installedNameSet,
  collectModelFolders,
  buildRequiredList,
} from './dependencyCheck.models.js';
import { buildPluginRequirementList } from './dependencyCheck.plugins.js';

export interface DependencyCheckResult {
  ready: boolean;
  required: RequiredItem[];
  missing: RequiredItem[];
}

const COMFYUI_URL = env.COMFYUI_URL;

export async function fetchTemplateWorkflow(
  templateName: string,
): Promise<Record<string, unknown> | null> {
  try {
    if (isUserWorkflow(templateName)) {
      return getUserWorkflowJson(templateName);
    }
    const wfRes = await fetch(
      `${COMFYUI_URL}/templates/${encodeURIComponent(templateName)}.json`,
    );
    if (!wfRes.ok) return null;
    const wfData = await wfRes.json();
    if (!wfData || typeof wfData !== 'object') return null;
    return wfData as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Short-lived memoization: the chat-tool registration path runs this once
// per stream, and the HTTP route is hit by the install modal — both can
// fire repeatedly within seconds. The 5s TTL is small enough to track
// real installs without forcing a full re-scan on every keystroke.
interface CacheEntry {
  expiresAt: number;
  result: DependencyCheckResult;
}
const memo = new Map<string, CacheEntry>();
const MEMO_TTL_MS = 5_000;

/**
 * Test-only helper to drop the in-memory memoization. Production code never
 * calls this — the TTL takes care of expiry on its own.
 */
export function resetDependencyCheckCacheForTests(): void {
  memo.clear();
}

async function computeTemplateDependencies(
  templateName: string,
): Promise<DependencyCheckResult> {
  const workflow = await fetchTemplateWorkflow(templateName);
  if (!workflow) return { ready: true, required: [], missing: [] };
  const allNodes = collectAllWorkflowNodes(workflow);
  if (allNodes.length === 0) return { ready: true, required: [], missing: [] };

  await catalog.seedFromComfyUI();
  const { required: requiredFilenames, templateDir, repoEntries } =
    collectRequirements(workflow, allNodes, templateName);
  await refreshStaleEntries(requiredFilenames);
  const installedModels = await fetchInstalledModels();
  const installedSet = installedNameSet(installedModels);
  const modelFolders = await collectModelFolders(workflow);
  const { required: modelsReq, missing: modelsMissing } = buildRequiredList({
    requiredFilenames, templateDir, modelFolders,
    installedModels, installedSet, repoEntries,
  });
  // Stamp the `kind` discriminator so the UI's union type can route models
  // vs plugins to the right renderer in a single `missing[]` list.
  const stampedModelsReq: RequiredModelInfo[] =
    modelsReq.map((m) => ({ kind: 'model', ...m }));
  const stampedModelsMissing: RequiredModelInfo[] =
    modelsMissing.map((m) => ({ kind: 'model', ...m }));
  const { required: pluginsReq, missing: pluginsMissing } =
    await buildPluginRequirementList(workflow);
  const required: RequiredItem[] = [...stampedModelsReq, ...pluginsReq];
  const missing: RequiredItem[] = [...stampedModelsMissing, ...pluginsMissing];
  return { ready: missing.length === 0, required, missing };
}

/**
 * Authoritative readiness check for a single template. Fetches the
 * workflow JSON, walks its nodes, and resolves every dependency against
 * live state. Result is memoized for 5 seconds so back-to-back calls
 * (HTTP route + chat tool gate) don't hammer the catalog scan.
 */
export async function checkTemplateDependencies(
  templateName: string,
): Promise<DependencyCheckResult> {
  const now = Date.now();
  const cached = memo.get(templateName);
  if (cached && cached.expiresAt > now) return cached.result;
  const result = await computeTemplateDependencies(templateName);
  memo.set(templateName, { result, expiresAt: now + MEMO_TTL_MS });
  return result;
}

/**
 * Recompute the cached `templates.installed` flag for `names` using the
 * authoritative workflow-walking dep check. The column itself is kept as
 * a coarse "ready / not ready" cache that the Templates list endpoint
 * (`templates.overlay.ts`) reads to render the per-card badge — option 2
 * from the cleanup task: keep the cached flag, but the writer is now the
 * same function the chat tool + install modal use, so the badge can never
 * disagree with the model-installation modal again.
 *
 * Errors are caught per-name so a single broken workflow doesn't poison
 * the whole batch (refresh / boot path drives this with the entire
 * catalog). The cache invalidation runs ahead of the recompute so we read
 * fresh state for every recompute pass.
 */
export async function recomputeTemplateReadiness(names: string[]): Promise<void> {
  if (names.length === 0) return;
  const ready: string[] = [];
  const notReady: string[] = [];
  // Per-template `checkTemplateDependencies` makes 1-2 HTTP calls to ComfyUI
  // (workflow fetch + cached object_info), so a sequential loop over 390
  // templates costs 30-90s wall-time on /api/templates/refresh. Run a small
  // worker pool to keep total time in the few-seconds range; 6 mirrors the
  // concurrency the upsert pass already uses (see refresh.ts).
  const CONCURRENCY = 6;
  let idx = 0;
  async function worker(): Promise<void> {
    while (idx < names.length) {
      const name = names[idx++];
      memo.delete(name);
      try {
        const result = await checkTemplateDependencies(name);
        (result.ready ? ready : notReady).push(name);
      } catch (err) {
        logger.warn('recomputeTemplateReadiness: per-template check failed', {
          name, error: err instanceof Error ? err.message : String(err),
        });
        notReady.push(name);
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, names.length) }, worker),
  );
  if (ready.length > 0) templateRepo.setInstalledForTemplates(ready, true);
  if (notReady.length > 0) templateRepo.setInstalledForTemplates(notReady, false);
}
