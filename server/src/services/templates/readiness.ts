// Template readiness computation.
//
// A template is "ready" when every model it requires is present on disk AND
// every custom-node plugin it requires is installed + enabled. We compute
// this in-memory against catalog snapshots — no network calls.
//
// Model presence is derived from:
//   - the live models catalog `installed` flag (fast path; reflects launcher
//     scan state).
//   - a disk stat fallback under `paths.modelsDir` for files that were
//     downloaded after the last scan.
//
// Plugin presence is derived from the plugins-cache catalog (which overlays
// disk scan onto the mirrored index) — a plugin counts when `installed` is
// true and `disabled` is false.

import { logger } from '../../lib/logger.js';
import * as templateRepo from '../../lib/db/templates.repo.js';
import type { TemplateDeps } from '../../lib/db/templates.repo.js';
import * as modelFiles from '../../lib/db/modelFiles.repo.js';
import { isPluginInstalled, getInstalledPluginKeys } from '../plugins/installedKeys.js';

interface ModelsView {
  installed: Set<string>;         // filenames + names, case-sensitive
}

interface PluginsView {
  /** Snapshot of every form (id, owner/repo, basename) that counts as
   *  "installed and enabled". Sourced via `getInstalledPluginKeys` so the
   *  stale catalog-only check (which missed disk-cloned plugins) is gone.
   */
  keys: ReturnType<typeof getInstalledPluginKeys>;
}

async function loadModelsView(): Promise<ModelsView> {
  const installed = new Set<string>();
  try {
    const mod = await import('../models/models.service.js');
    const list = await mod.scanAndRefresh();
    for (const m of list) {
      const w = mod.toWireEntry(m);
      if (!w.installed) continue;
      if (w.filename) installed.add(w.filename);
      if (w.name) installed.add(w.name);
    }
  } catch (err) {
    logger.warn('readiness: models view unavailable', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
  return { installed };
}

async function loadPluginsView(): Promise<PluginsView> {
  try {
    return { keys: getInstalledPluginKeys() };
  } catch (err) {
    logger.warn('readiness: plugins view unavailable', {
      message: err instanceof Error ? err.message : String(err),
    });
    return { keys: { set: new Set(), byCanonical: new Set() } };
  }
}

function modelOnDisk(filename: string): boolean {
  return modelFiles.hasComplete(filename);
}

export function isReadySync(
  deps: TemplateDeps,
  models: ModelsView,
  plugins: PluginsView,
): boolean {
  for (const fn of deps.models) {
    if (models.installed.has(fn)) continue;
    if (modelOnDisk(fn)) continue;
    return false;
  }
  for (const pid of deps.plugins) {
    if (!isPluginInstalled(pid, plugins.keys)) return false;
  }
  return true;
}

/**
 * Compute readiness for a single template against freshly-loaded catalog
 * snapshots. Returns `true` when both catalogs are satisfied.
 */
export async function isReady(deps: TemplateDeps): Promise<boolean> {
  const [models, plugins] = await Promise.all([loadModelsView(), loadPluginsView()]);
  return isReadySync(deps, models, plugins);
}

/**
 * Recompute the stored `installed` flag for every template in `names`. Rows
 * that turn ready are flipped to 1; rows that turn not-ready to 0. A single
 * shared catalog snapshot backs the whole batch so we never scan twice.
 */
export async function recomputeReadinessFor(names: string[]): Promise<void> {
  if (names.length === 0) return;
  const [models, plugins] = await Promise.all([loadModelsView(), loadPluginsView()]);
  const ready: string[] = [];
  const notReady: string[] = [];
  for (const name of names) {
    const row = templateRepo.getTemplate(name);
    if (!row) continue;
    const ok = isReadySync({ models: row.models, plugins: row.plugins }, models, plugins);
    (ok ? ready : notReady).push(name);
  }
  if (ready.length > 0) templateRepo.setInstalledForTemplates(ready, true);
  if (notReady.length > 0) templateRepo.setInstalledForTemplates(notReady, false);
}
