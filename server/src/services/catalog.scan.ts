// Helper that feeds catalog.ts the launcher-compatible scan shape from the
// local models service. Split out to keep `catalog.ts` under 250 lines.

import * as models from './models/models.service.js';

export interface LauncherScanEntry {
  filename: string;
  name?: string;
  installed?: boolean;
  fileSize?: number;
  type?: string;
  save_path?: string;
  url?: string;
  base?: string;
  description?: string;
  reference?: string;
}

export async function fetchLauncherScan(): Promise<LauncherScanEntry[]> {
  try {
    const list = await models.scanAndRefresh();
    const out: LauncherScanEntry[] = [];
    for (const m of list) {
      const wire = models.toWireEntry(m);
      if (!wire.filename) continue;
      out.push({
        filename: wire.filename,
        name: wire.name,
        installed: wire.installed,
        fileSize: wire.fileSize,
        type: wire.type,
        save_path: wire.save_path,
        url: wire.url,
        base: wire.base,
        description: wire.description,
        reference: wire.reference,
      });
    }
    return out;
  } catch {
    return [];
  }
}
