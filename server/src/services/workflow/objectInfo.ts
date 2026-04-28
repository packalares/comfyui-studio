// Cached `/api/object_info` lookup. ComfyUI's object_info response is large
// (tens of KB) and stable per-server-boot, so we fetch it once and memoise.
//
// Callers depend on a specific shape — `Record<classType, Record<string, unknown>>`
// — so we cast the parsed JSON once here and expose the typed view. The real
// schema is described by `Record<className, { input?, output?, display_name? }>`
// but we keep the generic object shape since each caller cares about a
// different subset of it.

import { env } from '../../config/env.js';
import * as bus from '../../lib/events.js';

const COMFYUI_URL = env.COMFYUI_URL;

export type ObjectInfo = Record<string, Record<string, unknown>>;

let cached: ObjectInfo | null = null;

/** Clear the memoised object_info. */
export function resetObjectInfoCache(): void {
  cached = null;
}

// object_info is "stable per-server-boot" only when ComfyUI's disk + installed
// plugins don't change. A model download adds a filename to a COMBO widget's
// options; a plugin install adds whole class types. Both invalidate the
// cached shape, so wire the existing event bus to drop the memo whenever
// underlying state changes. Next getObjectInfo() refreshes lazily — no extra
// HTTP round-trips when nothing changed.
bus.on('model:installed', () => { cached = null; });
bus.on('model:removed', () => { cached = null; });
bus.on('plugin:installed', () => { cached = null; });
bus.on('plugin:removed', () => { cached = null; });
bus.on('plugin:enabled', () => { cached = null; });
bus.on('plugin:disabled', () => { cached = null; });

/** Seed the cache with a pre-built object_info (test-only helper). */
export function seedObjectInfoCache(info: ObjectInfo): void {
  cached = info;
}

export async function getObjectInfo(): Promise<ObjectInfo> {
  if (cached) return cached;
  try {
    const res = await fetch(`${COMFYUI_URL}/api/object_info`);
    if (res.ok) cached = (await res.json()) as ObjectInfo;
  } catch {
    // ComfyUI unreachable — return empty so extraction paths don't crash.
  }
  return cached ?? {};
}
