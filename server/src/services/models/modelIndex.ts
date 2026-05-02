// Public surface for the SQLite-backed model index.
//
// The walker lives in `modelIndex.scan.ts`; this file owns the mutex, the
// freshness gate, the bus subscriptions, and the small read accessors that
// other services reach for. A single mutex (`inFlight`) collapses concurrent
// rebuilds onto one walk so back-to-back boots / route hits don't fan out.

import { logger } from '../../lib/logger.js';
import * as bus from '../../lib/events.js';
import * as modelFiles from '../../lib/db/modelFiles.repo.js';
import {
  rebuildAll, syncOneAbsPath, type RebuildOutcome,
} from './modelIndex.scan.js';

const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

let inFlight: Promise<RebuildOutcome> | null = null;
let wired = false;

export async function rebuildFullIndex(): Promise<RebuildOutcome> {
  if (inFlight) return inFlight;
  inFlight = rebuildAll().finally(() => { inFlight = null; });
  return inFlight;
}

export async function syncOne(absPath: string): Promise<void> {
  await syncOneAbsPath(absPath);
}

export function removeOne(absPath: string): void {
  modelFiles.removeByAbsPath(absPath);
}

/**
 * Trigger a rebuild only when the index is empty or the oldest stamp is
 * older than `maxAgeMs`. Boot wiring calls this so the very first readiness
 * recompute sees a populated table without paying the walk on every restart.
 */
export async function ensureFresh(
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
): Promise<void> {
  const total = modelFiles.countAll();
  if (total === 0) {
    await rebuildFullIndex();
    return;
  }
  const oldest = modelFiles.oldestScannedAt();
  if (oldest != null && oldest < Date.now() - maxAgeMs) {
    await rebuildFullIndex();
  }
}

export function getKnownTopDirs(): Set<string> {
  return modelFiles.listKnownTopDirs();
}

/**
 * Subscribe to the model lifecycle bus once. The install path emits
 * `model:installed` with the absolute on-disk path; we sync that single row
 * instead of a full walk. Removal events drop every row whose filename
 * matches (a single filename can live in multiple roots/dirs).
 */
export function wireModelIndexEventHandlers(): void {
  if (wired) return;
  wired = true;
  subscribe();
}

/** Test-only: re-subscribe after `bus.resetForTests()`. */
export function rewireForTests(): void {
  wired = true;
  subscribe();
}

function subscribe(): void {
  bus.on('model:installed', (payload) => {
    void (async () => {
      const absPath = (payload as { absPath?: string }).absPath;
      if (typeof absPath !== 'string' || absPath.length === 0) return;
      try {
        await syncOneAbsPath(absPath);
      } catch (err) {
        logger.warn('modelIndex model:installed sync failed', {
          absPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  });

  bus.on('model:removed', ({ filename }) => {
    try {
      const rows = modelFiles.listByFilename(filename);
      for (const row of rows) modelFiles.removeByAbsPath(row.abs_path);
    } catch (err) {
      logger.warn('modelIndex model:removed sync failed', {
        filename,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
