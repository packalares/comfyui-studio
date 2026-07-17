// Event hook: download preview images asynchronously when a model is enriched.
//
// WHY decoupled: Wave 3 emits `model:enriched` after writing the sidecar.
// Hooking here avoids touching enrich.ts (Wave 4 owns it) and keeps the
// download concern isolated to this module.

import * as bus from '../../../lib/events.js';
import { logger } from '../../../lib/logger.js';
import { readSidecar, writeSidecar } from './sidecar.js';
import { downloadPreviewFor, hasLocalPreview, previewPathFor } from './previewDownload.js';
import path from 'path';

export function registerPreviewHook(): void {
  bus.on('model:enriched', (payload) => {
    const { absPath } = payload;

    // Fire-and-forget: read sidecar inline to decide whether to act.
    void (async () => {
      const sidecar = readSidecar(absPath);
      if (!sidecar?.preview_remote_url) return;
      if (sidecar.preview_local_path) return;

      // Check disk in case the sidecar field is just stale.
      if (await hasLocalPreview(absPath)) {
        const rel = path.basename(previewPathFor(absPath));
        writeSidecar(absPath, { ...sidecar, preview_local_path: rel });
        return;
      }

      const result = await downloadPreviewFor(absPath, sidecar.preview_remote_url);
      if (!result.ok) {
        logger.warn('previewHook: download failed', {
          filename: sidecar.filename,
          error: result.error,
        });
        return;
      }

      // Store relative path (just filename — same dir as model).
      const rel = path.basename(result.localPath);
      writeSidecar(absPath, { ...sidecar, preview_local_path: rel });
      logger.info('previewHook: preview saved', {
        filename: sidecar.filename,
        bytes: result.bytes,
      });
    })();
  });
}
