// Header-parse enrich pass: for model_files rows that are header-parsable and
// not yet scanned (or changed since the last parse), read the header, detect
// the architecture, and persist the measured facts. Header reads are ~ms each
// (no tensor data), and the pass is incremental — only new/changed files.
//
// Even an unreadable/mislabelled file gets its row stamped (integrity !=' ok',
// family Unknown) so it isn't re-parsed every pass until its size changes.

import fs from 'node:fs';
import { logger } from '../../../lib/logger.js';
import * as modelFiles from '../../../lib/db/modelFiles.repo.js';
import { parseModelHeader, isHeaderParsable } from './index.js';
import { detectArch } from '../arch/detect.js';

/** Parse + persist header/arch info for a single file. No-op for non-parsable. */
export function enrichOne(absPath: string, size?: number): void {
  if (!isHeaderParsable(absPath)) return;
  let fsize = size;
  if (fsize === undefined) {
    try { fsize = fs.statSync(absPath).size; } catch { return; }
  }
  const header = parseModelHeader(absPath);
  const arch = detectArch(header);
  modelFiles.saveHeaderInfo(absPath, {
    arch_family: arch.archFamily,
    arch_source: arch.archSource,
    arch_confidence: arch.archConfidence,
    role: arch.role,
    precision: arch.precision,
    quantization: arch.quantization,
    param_count: arch.paramCount,
    is_bundled: arch.isBundled,
    integrity: header.integrity,
    integrity_note: header.integrityNote ?? null,
    signals: arch.signals,
    header_size: fsize,
  });
}

/** Enrich every file that still needs it. Returns how many were parsed. */
export function enrichPending(opts: { limit?: number } = {}): { scanned: number; durationMs: number } {
  const t0 = Date.now();
  const rows = modelFiles.listNeedingHeaderScan(opts.limit);
  let scanned = 0;
  for (const r of rows) {
    try {
      enrichOne(r.abs_path, r.size);
      scanned++;
    } catch (e) {
      logger.warn('model header enrich failed', {
        file: r.abs_path,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  const durationMs = Date.now() - t0;
  if (scanned > 0) logger.info('model header enrich', { scanned, durationMs });
  return { scanned, durationMs };
}
