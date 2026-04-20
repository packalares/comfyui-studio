// Shared retry-enabled download used by every non-plugin resource installer.
// Replaces the launcher's three duplicate copies of "try each source with
// cleanup on failure" loops with a single function.

import fs from 'fs';
import { logger } from '../../lib/logger.js';
import { downloadFile } from '../../lib/download/index.js';
import type { DownloadProgress } from '../../contracts/models.contract.js';
import { InstallStatus } from '../../contracts/resourcePacks.contract.js';
import type { SourcedUrl } from './downloadUrls.js';

export type OnProgress = (status: InstallStatus, progress: number, error?: string) => void;

export interface DownloadAttemptOptions {
  outputPath: string;
  urls: SourcedUrl[];
  abortController: AbortController;
  onProgress: OnProgress;
  /** Human-readable name for log context. */
  resourceName: string;
  /** When true, empty files count as "failed" rather than "complete". */
  requireNonEmpty: boolean;
}

const CANCEL_PATTERN = /(canceled|cancelled|abort|aborted)/i;

/** Rename `.download` temp file back to the destination if the final is absent. */
export function finalizeDownload(filePath: string): string {
  const tmp = `${filePath}.download`;
  if (!fs.existsSync(filePath) && fs.existsSync(tmp)) {
    try { fs.renameSync(tmp, filePath); } catch { return tmp; }
  }
  return filePath;
}

function removeIfExists(p: string): void {
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
}

function cleanupPartials(outputPath: string): void {
  removeIfExists(outputPath);
  removeIfExists(`${outputPath}.download`);
}

/**
 * Attempt every URL in `urls` until one succeeds. Progress is reported via
 * `onProgress` with DOWNLOADING while active, COMPLETED on success, CANCELED
 * if aborted, and ERROR after all URLs fail.
 */
export async function tryDownloadWithFallbacks(opts: DownloadAttemptOptions): Promise<boolean> {
  let lastPercent = 0;
  let lastError: Error | null = null;
  for (const { url, source } of opts.urls) {
    try {
      opts.onProgress(InstallStatus.DOWNLOADING, 0);
      logger.info('resource download attempt', { resource: opts.resourceName, source, url });
      const progressCb = (percent: number, _downloaded: number, _total: number): void => {
        lastPercent = percent;
        opts.onProgress(InstallStatus.DOWNLOADING, percent);
      };
      const ok = await downloadFile(
        url,
        opts.outputPath,
        progressCb,
        {
          abortController: opts.abortController,
          onProgress: (_p: DownloadProgress) => { /* positional cb above used */ },
        },
        undefined,
      );
      if (!ok) {
        opts.onProgress(InstallStatus.CANCELED, lastPercent);
        return false;
      }
      const finalPath = finalizeDownload(opts.outputPath);
      if (!fs.existsSync(finalPath)) throw new Error(`File missing after download: ${finalPath}`);
      if (opts.requireNonEmpty) {
        const st = fs.statSync(finalPath);
        if (st.size <= 0) {
          fs.unlinkSync(finalPath);
          throw new Error(`Downloaded file has zero size: ${finalPath}`);
        }
      }
      opts.onProgress(InstallStatus.COMPLETED, 100);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lastError = err instanceof Error ? err : new Error(msg);
      if (opts.abortController.signal.aborted || CANCEL_PATTERN.test(msg)) {
        opts.onProgress(InstallStatus.CANCELED, lastPercent);
        cleanupPartials(opts.outputPath);
        throw lastError;
      }
      logger.warn('resource download failed', { resource: opts.resourceName, source, message: msg });
      cleanupPartials(opts.outputPath);
    }
  }
  const msg = `All sources failed for ${opts.resourceName}: ${lastError?.message ?? 'unknown'}`;
  opts.onProgress(InstallStatus.ERROR, 0, msg);
  throw new Error(msg);
}
