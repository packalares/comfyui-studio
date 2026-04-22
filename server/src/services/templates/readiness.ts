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

import { paths } from '../../config/paths.js';
import { MODEL_SUBDIRS } from '../../config/modelDirs.js';
import { statModelOnDisk } from '../../lib/fs.js';
import { logger } from '../../lib/logger.js';
import * as templateRepo from '../../lib/db/templates.repo.js';
import type { TemplateDeps } from '../../lib/db/templates.repo.js';

interface ModelsView {
  installed: Set<string>;         // filenames + names, case-sensitive
}

interface PluginsView {
  enabled: Set<string>;           // lowercased plugin ids
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
  const enabled = new Set<string>();
  try {
    // Dynamic import so boot-order + test harnesses that mock the plugins
    // cache keep working.
    const cache = await import('../plugins/cache.service.js');
    for (const p of cache.getAllPlugins()) {
      if (!p.installed || p.disabled) continue;
      if (p.id) enabled.add(p.id.toLowerCase());
      const repo = (p.repository || p.github || '').toLowerCase()
        .replace(/^https?:\/\/github\.com\//, '')
        .replace(/\.git$/, '')
        .replace(/\/$/, '');
      if (repo) enabled.add(repo);
    }
  } catch (err) {
    logger.warn('readiness: plugins view unavailable', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
  return { enabled };
}

function modelOnDisk(filename: string): boolean {
  const root = paths.modelsDir;
  if (!root) return false;
  // Stat every known subdir; we don't know which one owns the file so we
  // try each one and stop on the first hit. The MODEL_SUBDIRS list is
  // shared with install.service.ts — see config/modelDirs.ts.
  for (const dir of MODEL_SUBDIRS) {
    if (statModelOnDisk(root, dir, filename) !== null) return true;
  }
  return false;
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
    if (!plugins.enabled.has(pid.toLowerCase())) return false;
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
