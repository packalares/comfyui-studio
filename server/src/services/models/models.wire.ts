// Launcher-compatible wire shape for `/api/models` responses. Split out of
// `models.service.ts` to keep each file under the 250-line cap.
//
// Studio's `catalog.getMergedModels` consumes this exact shape; must not
// drift without a matching update over there.

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

/** Flatten a catalog entry into the launcher-wire shape. */
export function toWireEntry(m: CatalogModelEntry): LauncherCompatEntry {
  const url = typeof m.url === 'string'
    ? m.url
    : m.url?.hf || m.url?.mirror || m.url?.cdn;
  return {
    filename: m.filename,
    name: m.name,
    save_path: m.save_path,
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
