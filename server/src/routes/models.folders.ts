// Handler + cache for `GET /models/folders`. Surfaces ComfyUI's registered
// model-directory names so the Models page can offer an explicit picker
// when a catalog row has no `save_path`. Cached briefly because folders
// only change on a ComfyUI restart, which already nukes our process state.

import type { RequestHandler } from 'express';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

const FOLDERS_CACHE_TTL_MS = 60_000;
let foldersCache: { value: string[]; expiresAt: number } | null = null;

export function clearFoldersCache(): void {
  foldersCache = null;
}

export const handleFolders: RequestHandler = async (_req, res) => {
  const now = Date.now();
  if (foldersCache && foldersCache.expiresAt > now) {
    res.json(foldersCache.value);
    return;
  }
  try {
    const upstream = await fetch(`${env.COMFYUI_URL}/experiment/models`);
    if (!upstream.ok) throw new Error(`upstream status ${upstream.status}`);
    const raw = await upstream.json() as Array<{ name?: unknown }> | unknown;
    const list = Array.isArray(raw) ? raw : [];
    const names = list
      .map((row) => (row && typeof row === 'object' ? (row as { name?: unknown }).name : null))
      .filter((n): n is string => typeof n === 'string' && n.length > 0)
      .sort((a, b) => a.localeCompare(b));
    foldersCache = { value: names, expiresAt: now + FOLDERS_CACHE_TTL_MS };
    res.json(names);
  } catch (err) {
    logger.warn('models folders fetch failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    res.json([]);
  }
};
