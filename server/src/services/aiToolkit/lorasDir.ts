// Resolves ComfyUI's real `models/loras/` directory so a finished LoRA can
// be dropped where comfy's own image generation will actually find it.
//
// Preferred source: `services/catalog/folderRegistry.ts`'s live cache of
// ComfyUI's `/api/experiment/models` response — the actual configured
// folder(s) for the `loras` type, handling any custom `extra_model_paths.yaml`
// remapping or custom_node-registered aliases. That registry is only
// populated while ComfyUI is reachable, though, and training runs on the
// `oneshot` GPU tenant specifically BECAUSE `residency.ts` evicts comfy
// first (see `services/gpu/taskTypes.ts`) — so by the time a job finishes,
// ComfyUI is very likely stopped and the registry may be stale/empty.
// Fallback: `${COMFYUI_PATH}/models/loras`, the same default `download.ts`
// uses when writing a downloaded LoRA to disk.

import path from 'path';
import { env } from '../../config/env.js';
import { getPathsForFolder } from '../catalog/folderRegistry.js';

/** Best-effort resolution of ComfyUI's loras directory. Never touches disk —
 *  callers are responsible for `mkdir -p` before writing into it. */
export function resolveComfyLorasDir(): string {
  const registered = getPathsForFolder('loras');
  if (registered.length > 0) return registered[0];
  return path.join(env.COMFYUI_PATH, 'models', 'loras');
}
