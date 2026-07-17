// Model catalog routes.

import { Router } from 'express';
import * as catalog from '../services/catalog/index.js';
import { paginate, splitPaginated } from '../lib/pagination.js';
import { defineRoute } from '../lib/defineRoute.js';
import { catalogRoutes } from '../contracts/catalog.contract.js';

// ---- GET /models/catalog ----

export const catalogListRoute = defineRoute(catalogRoutes.list, async (ctx) => {
  const { page, pageSize = 100, q, type, installed, filenames } = ctx.query;
  const all = await catalog.getMergedModels();

  if (page === undefined) {
    return ctx.ok(all);
  }

  let rows = all;
  if (installed === 'true') rows = rows.filter((m) => m.installed);
  else if (installed === 'false') rows = rows.filter((m) => !m.installed);

  if (type) {
    const typeFilter = new Set(type.split(',').map((s) => s.trim()).filter(Boolean));
    if (typeFilter.size > 0) rows = rows.filter((m) => typeFilter.has(m.type || 'other'));
  }

  if (filenames) {
    // Template-driven filter: narrow to catalog rows whose `filename` or
    // `name` matches one of the basenames the workflow needs. Both fields
    // are checked because catalog rows may key by either depending on
    // import path (template seed vs scan vs manual upsert).
    const wanted = new Set(filenames.split(',').map((s) => s.trim()).filter(Boolean));
    if (wanted.size > 0) {
      rows = rows.filter((m) => wanted.has(m.filename) || wanted.has(m.name));
    }
  }

  if (q) {
    const lq = q.toLowerCase().trim();
    rows = rows.filter((m) =>
      (m.name || '').toLowerCase().includes(lq) ||
      (m.filename || '').toLowerCase().includes(lq) ||
      (m.type || '').toLowerCase().includes(lq),
    );
  }

  const { items, meta } = splitPaginated(paginate(rows, page, pageSize));
  return ctx.ok(items, meta);
});

// ---- GET /models/stats ----

export const catalogStatsRoute = defineRoute(catalogRoutes.stats, async (ctx) => {
  const all = await catalog.getMergedModels();
  let installedCount = 0;
  let totalDiskSize = 0;
  const types = new Set<string>();
  for (const m of all) {
    if (m.installed) {
      installedCount++;
      totalDiskSize += m.fileSize ?? 0;
    }
    types.add(m.type || 'other');
  }
  return ctx.ok({
    installedCount,
    available: all.length,
    totalDiskSize,
    types: Array.from(types).sort(),
  });
});

const router = Router();
catalogListRoute.register(router);
catalogStatsRoute.register(router);

export default router;
