// Version-gated catalog migration. Runs at most ONCE per version bump, at
// backend startup. Walks every row through the canonicalize gate, dedups by
// `(save_path, filename)`, writes the cleaned set back, bumps the schema
// version so the migration never runs again.
//
// All future writes go through `upsertModel` which calls canonicalize itself,
// so the catalog stays clean without further intervention.
//
// Migration semantics:
//   - canonicalize → DedupResult.survivors → persist
//   - rows marked `unrecoverable` (Windows abs paths, placeholders with no
//     hfRepo hint) are dropped, logged, and counted
//   - rows with `pendingNodeInstall=true` are preserved with that flag set
//   - schema_version bumped from 1 → 2 on success
//
// Run trigger: server boot calls `migrateCatalogIfNeeded()` once. Safe to call
// repeatedly; it's a no-op after first success.

import { load, persist, type CatalogFile } from './store.js';
import { canonicalize, dedupRows } from './canonicalize.js';
import { refreshRegistry } from './folderRegistry.js';
import type { CatalogModel } from '../../contracts/catalog.contract.js';
import { logger } from '../../lib/logger.js';

// v2: initial canonicalize pass (filename split, save_path normalization, alias, type derivation)
// v3: expanded typeMap — adds GGUF variants, depth/colorization/segmentation,
//     case-insensitive lookup. Re-runs canonicalize so rows previously
//     mapped to 'other' get reclassified.
const TARGET_VERSION = 3;

interface MigrationReport {
  before: number;
  after: number;
  unrecoverable: number;
  mergedAwayCount: number;
  pendingNodeInstall: number;
}

export async function migrateCatalogIfNeeded(): Promise<MigrationReport | null> {
  const data = load();
  if ((data.version ?? 0) >= TARGET_VERSION) return null;

  logger.info('catalog migrate: starting', { from: data.version ?? 0, to: TARGET_VERSION });

  // Make sure the folder registry is hot so canonicalize can do disk lookups.
  await refreshRegistry(true);

  const report: MigrationReport = {
    before: data.models.length,
    after: 0,
    unrecoverable: 0,
    mergedAwayCount: 0,
    pendingNodeInstall: 0,
  };

  const cleaned: CatalogModel[] = [];
  for (const row of data.models) {
    const result = await canonicalize(row);
    if (result.unrecoverable) {
      report.unrecoverable++;
      logger.info('catalog migrate: dropped unrecoverable row', {
        filename: row.filename, save_path: row.save_path,
        notes: result.notes,
      });
      continue;
    }
    const out = result.entry as CatalogModel;
    if (result.pendingNodeInstall) {
      report.pendingNodeInstall++;
      // (Field is added cosmetically; UI consumers handle absence as false.)
      (out as CatalogModel & { pendingNodeInstall?: boolean }).pendingNodeInstall = true;
    }
    cleaned.push(out);
  }

  const dedup = dedupRows(cleaned);
  report.mergedAwayCount = dedup.mergedAwayCount;
  report.after = dedup.survivors.length;

  const next: CatalogFile = {
    ...data,
    version: TARGET_VERSION,
    models: dedup.survivors,
  };
  persist(next);

  logger.info('catalog migrate: done', report);
  return report;
}
