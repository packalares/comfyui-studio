// Shared helpers for videoboard sub-routers.

import fs from 'fs';
import { paths } from '../config/paths.js';
import { resolveWithin } from '../lib/pathSafe.js';

/** True if a /api/view?... URL resolves to a real file on disk. */
export function viewUrlPointsToExistingFile(url: string | undefined | null): boolean {
  if (!url) return false;
  const q = url.indexOf('?');
  if (q < 0) return false;
  const p = new URLSearchParams(url.slice(q + 1));
  const filename = p.get('filename');
  if (!filename) return false;
  const type = p.get('type') ?? 'output';
  const subfolder = p.get('subfolder') ?? '';
  const root = type === 'output' ? paths.comfyOutputDir : paths.comfyInputDir;
  const abs = resolveWithin(root, subfolder, filename);
  if (abs == null) return false;
  return fs.existsSync(abs);
}

/** Best-effort unlink of orphaned view-URL-backed files. Never throws. */
export function deleteOrphanedFiles(urls: string[]): void {
  const outputDir = paths.comfyOutputDir;
  if (!outputDir || urls.length === 0) return;
  for (const url of urls) {
    try {
      const q = url.indexOf('?');
      if (q < 0) continue;
      const params = new URLSearchParams(url.slice(q + 1));
      const filename = params.get('filename');
      if (!filename) continue;
      if ((params.get('type') ?? 'output') !== 'output') continue;
      const subfolder = params.get('subfolder') ?? '';
      const abs = resolveWithin(outputDir, subfolder, filename);
      if (abs == null) continue;
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    } catch { /* best-effort */ }
  }
}
