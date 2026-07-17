// SHA256 computation and background hash queue.
//
// D1: Full-file SHA256 (not AutoV2 first-256 KB).
// Queue: pulls from `listMissingSha256`, concurrency=1, idle priority.

import crypto from 'crypto';
import fs from 'fs';
import { logger } from '../../../lib/logger.js';
import * as modelFiles from '../../../lib/db/modelFiles.repo.js';

/** Compute the full-file SHA256 of `absPath` as a lowercase hex string. */
export async function computeSha256(absPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(absPath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// ---- Background hash queue ----

let queueRunning = false;

/** Small pause between files to avoid monopolising I/O during normal usage. */
const INTER_FILE_DELAY_MS = 500;

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Process one batch from `listMissingSha256` (up to 100 rows). Returns the
 * number of files processed in this pass.
 */
async function processBatch(): Promise<number> {
  const rows = modelFiles.listMissingSha256(100);
  if (rows.length === 0) return 0;

  for (const row of rows) {
    try {
      const sha256 = await computeSha256(row.abs_path);
      modelFiles.setSha256(row.abs_path, sha256);
      logger.info('hash-queue: computed sha256', {
        file: row.filename,
        sha256: sha256.slice(0, 12) + '…',
      });
    } catch (err) {
      logger.warn('hash-queue: failed to hash file', {
        file: row.abs_path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // Idle pause between files.
    await sleep(INTER_FILE_DELAY_MS);
  }
  return rows.length;
}

/**
 * Start the background hash queue. Idempotent — calling again when already
 * running is a no-op. Runs until all missing hashes are filled, then exits.
 * Call again (e.g. after a rescan) to restart.
 */
export function startHashQueue(): void {
  if (queueRunning) return;
  queueRunning = true;

  void (async () => {
    logger.info('hash-queue: started');
    try {
      while (true) {
        const processed = await processBatch();
        if (processed === 0) break;
        // Brief pause before checking for more rows.
        await sleep(200);
      }
    } catch (err) {
      logger.error('hash-queue: unexpected error', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      queueRunning = false;
      logger.info('hash-queue: idle — all files hashed');
    }
  })();
}

/** Exposed for tests: is the queue currently running? */
export function isHashQueueRunning(): boolean {
  return queueRunning;
}
