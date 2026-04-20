// Cached `/api/object_info` lookup. ComfyUI's object_info response is large
// (tens of KB) and stable per-server-boot, so we fetch it once and memoise.
//
// Callers depend on a specific shape — `Record<classType, Record<string, unknown>>`
// — so we cast the parsed JSON once here and expose the typed view. The real
// schema is described by `Record<className, { input?, output?, display_name? }>`
// but we keep the generic object shape since each caller cares about a
// different subset of it.

import { env } from '../../config/env.js';

const COMFYUI_URL = env.COMFYUI_URL;

export type ObjectInfo = Record<string, Record<string, unknown>>;

let cached: ObjectInfo | null = null;

/** Clear the memoised object_info (test-only; callers shouldn't need this). */
export function resetObjectInfoCache(): void {
  cached = null;
}

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
