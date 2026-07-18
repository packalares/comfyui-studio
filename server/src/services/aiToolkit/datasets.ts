// Image-LoRA training dataset storage: one folder per dataset under
// `paths.aiToolkitDatasetsDir`, each holding uploaded images plus optional
// sibling `<basename>.txt` caption files — ai-toolkit's own dataset
// convention (see `config.ts`'s header comment / `DatasetConfig.caption_ext`).

import fs from 'fs';
import path from 'path';
import { paths } from '../../config/paths.js';
import { safeResolve } from '../../lib/fs.js';

export const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

export interface DatasetSummary {
  name: string;
  imageCount: number;
  captionedCount: number;
  updatedAt: number | null;
}

/** Resolve a dataset name to its absolute directory, guarded against
 *  traversal. Throws if `name` escapes `aiToolkitDatasetsDir`. */
export function datasetDir(name: string): string {
  return safeResolve(paths.aiToolkitDatasetsDir, name);
}

export function countImages(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((f) => IMAGE_EXTS.has(path.extname(f).toLowerCase())).length;
}

/** List every dataset folder with a quick image/caption count. Non-recursive,
 *  top-level scan only — matches the flat dropdown the training UI shows. */
export function listDatasets(): DatasetSummary[] {
  const root = paths.aiToolkitDatasetsDir;
  if (!fs.existsSync(root)) return [];
  const out: DatasetSummary[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    let files: string[] = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    const fileSet = new Set(files);
    const images = files.filter((f) => IMAGE_EXTS.has(path.extname(f).toLowerCase()));
    const captionedCount = images.filter((f) => fileSet.has(`${path.basename(f, path.extname(f))}.txt`)).length;
    let updatedAt: number | null = null;
    try { updatedAt = Math.round(fs.statSync(dir).mtimeMs); } catch { /* ignore */ }
    out.push({ name: entry.name, imageCount: images.length, captionedCount, updatedAt });
  }
  return out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}
