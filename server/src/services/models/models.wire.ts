// Launcher-compatible wire shape for `/api/models` responses. Split out of
// `models.service.ts` to keep each file under the 250-line cap.
//
// Studio's `catalog.getMergedModels` consumes this exact shape; must not
// drift without a matching update over there.

import path from 'path';
import { env } from '../../config/env.js';
import type { CatalogModelEntry } from './download.service.js';

export interface LauncherCompatEntry {
  filename?: string;
  name?: string;
  save_path: string;
  type?: string;
  fileSize?: number;
  installed?: boolean;
  url?: string;
  base?: string;
  description?: string;
  reference?: string;
  fileStatus?: 'complete' | 'incomplete' | 'corrupted' | 'unknown';
  size?: string;
}

/** Strip the COMFYUI_PATH prefix from a catalog `save_path` so the wire never
 *  carries an absolute filesystem path. Older catalog imports occasionally
 *  stored an abs path here; everywhere else the value is already relative. */
function relativizeSavePath(savePath: string): string {
  if (!savePath || !path.isAbsolute(savePath)) return savePath;
  const root = env.COMFYUI_PATH;
  if (!root) return path.basename(savePath);
  const rel = path.relative(root, savePath);
  // `path.relative` yields '..' when savePath escapes root; in that case
  // surface only the basename so we don't emit a traversal segment either.
  return rel.startsWith('..') ? path.basename(savePath) : rel;
}

/** Flatten a catalog entry into the launcher-wire shape. */
export function toWireEntry(m: CatalogModelEntry): LauncherCompatEntry {
  const url = typeof m.url === 'string'
    ? m.url
    : m.url?.hf || m.url?.mirror || m.url?.cdn;
  return {
    filename: m.filename,
    name: m.name,
    save_path: relativizeSavePath(m.save_path),
    type: m.type,
    fileSize: m.fileSize,
    installed: m.installed,
    url,
    base: m.base,
    description: m.description,
    reference: m.reference,
    fileStatus: m.fileStatus,
    size: m.size,
  };
}
