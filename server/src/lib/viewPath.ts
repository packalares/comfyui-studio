// Shared path-resolution for gallery media files. Originally lived inline in
// `routes/view.routes.ts`; Wave P lifted it into a lib so the new video
// thumbnail route can reuse the same sanitization + traversal guard without
// duplicating the logic.
//
// The resolver maps a `(filename, subfolder, type)` triple — the shape used
// by ComfyUI's `/api/view` URLs — onto `${COMFYUI_PATH}/<typeDir>/<subfolder>/<filename>`.
// Anything that would escape the composed type-dir (traversal, absolute
// path, null byte, unknown type) returns `null`.

import path from 'path';
import { env } from '../config/env.js';
import { resolveWithin } from './pathSafe.js';

// sanitizeSegment now lives in the shared pathSafe module; re-exported here so
// existing importers (view / download routes, mediaLibrary) keep working.
export { sanitizeSegment } from './pathSafe.js';

export interface ResolvedViewPath {
  absPath: string;
  rootAbs: string;
}

/**
 * Compose + traversal-check the on-disk path for a `/view`-style request.
 * Returns `null` when the segments are malformed or `COMFYUI_PATH` is unset.
 */
export function resolveViewPath(
  filename: string, subfolder: string, type: string,
): ResolvedViewPath | null {
  const root = env.COMFYUI_PATH;
  if (!root) return null;
  const typeDir = ({ output: 'output', input: 'input', temp: 'temp' } as const)[
    (type || 'output') as 'output' | 'input' | 'temp'
  ];
  if (!typeDir) return null;
  const rootAbs = path.resolve(root, typeDir);
  const abs = resolveWithin(rootAbs, subfolder, filename);
  if (abs == null) return null;
  return { absPath: abs, rootAbs };
}
