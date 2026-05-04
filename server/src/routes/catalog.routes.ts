// Model catalog routes. The merged view is the single source of truth the UI
// consumes; the refresh endpoint is used as a just-in-time size-lookup trigger
// before the frontend shows a download progress bar.

import { Router, type Request, type Response } from 'express';
import * as catalog from '../services/catalog.js';
import { parsePageQuery, paginate } from '../lib/pagination.js';

const router = Router();

// Merged view: catalog + launcher disk scan joined with install state.
//
// When `?page=` is absent, returns the full flat array (legacy shape).
// When `?page=` is present, applies optional `?q=` / `?type=` / `?installed=`
// filters globally BEFORE slicing so pagination lines up with user intent.
router.get('/models/catalog', async (req: Request, res: Response) => {
  const all = await catalog.getMergedModels();
  const pq = parsePageQuery(req, { defaultPageSize: 100, maxPageSize: 500 });
  if (!pq.isPaginated) { res.json(all); return; }

  const q = typeof req.query.q === 'string' ? req.query.q.toLowerCase().trim() : '';
  const typeFilter = typeof req.query.type === 'string' && req.query.type
    ? new Set(req.query.type.split(',').map((s) => s.trim()).filter(Boolean))
    : null;
  const installedParam = typeof req.query.installed === 'string' ? req.query.installed : '';
  let rows = all;
  if (installedParam === 'true') rows = rows.filter((m) => m.installed);
  else if (installedParam === 'false') rows = rows.filter((m) => !m.installed);
  if (typeFilter && typeFilter.size > 0) {
    rows = rows.filter((m) => typeFilter.has(m.type || 'other'));
  }
  if (q) {
    rows = rows.filter((m) =>
      (m.name || '').toLowerCase().includes(q) ||
      (m.filename || '').toLowerCase().includes(q) ||
      (m.type || '').toLowerCase().includes(q),
    );
  }

  res.json(paginate(rows, pq.page, pq.pageSize));
});

// Sidebar aggregates: installed count, total on-disk bytes, and the set of
// distinct types in the merged catalog. Replaces the old pattern where the
// UI fetched the full catalog (`/models/catalog`) just to compute these
// numbers locally. Server iterates the merged list once per call; cheap,
// not cached (the catalog mutates on download/delete and the values must
// stay current with the sidebar).
router.get('/models/stats', async (_req: Request, res: Response) => {
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
  res.json({
    installedCount,
    available: all.length,
    totalDiskSize,
    types: Array.from(types).sort(),
  });
});

export default router;
