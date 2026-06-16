// Media library backed by ComfyUI's `input/` directory.
//
// One flat directory holds everything; we filter by extension and bucket
// new uploads into `input/images/`, `input/audio/`, `input/videos/`. The
// kind subfolders are purely organizational — ComfyUI's LoadImage /
// LoadAudio nodes scan input/ recursively, so files in subfolders show
// up in their combo lists as `<subfolder>/<filename>` and load correctly
// without any extra config.

import fs from 'fs';
import path from 'path';
import { env } from '../config/env.js';
import { sanitizeSegment } from '../lib/viewPath.js';

export type MediaKind = 'image' | 'audio' | 'video';

const EXTS_BY_KIND: Record<MediaKind, Set<string>> = {
  image: new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']),
  audio: new Set(['.wav', '.mp3', '.flac', '.ogg', '.m4a', '.aac', '.opus']),
  video: new Set(['.mp4', '.webm', '.mov', '.mkv', '.m4v']),
};

const SUBFOLDER_BY_KIND: Record<MediaKind, string> = {
  image: 'images',
  audio: 'audio',
  video: 'videos',
};

const INPUT_DIR = (): string => path.join(env.COMFYUI_PATH, 'input');
const LIST_LIMIT = 200;
const SCAN_MAX_DEPTH = 4;

export function subfolderForKind(kind: MediaKind): string {
  return SUBFOLDER_BY_KIND[kind];
}

export function extsFor(kind: MediaKind): Set<string> {
  return EXTS_BY_KIND[kind];
}

export interface LibraryItem {
  filename: string;
  /** Empty for files at input/ root. Otherwise the relative path (e.g. "images"). */
  subfolder: string;
  /** `<subfolder>/<filename>` if subfolder set, else just filename. The form
   *  ComfyUI's LoadImage / LoadAudio nodes expect on submit. */
  ref: string;
  sizeBytes: number;
  /** Modification time in ms since epoch. */
  mtimeMs: number;
  kind: MediaKind;
}

function kindOf(ext: string): MediaKind | null {
  if (EXTS_BY_KIND.image.has(ext)) return 'image';
  if (EXTS_BY_KIND.audio.has(ext)) return 'audio';
  if (EXTS_BY_KIND.video.has(ext)) return 'video';
  return null;
}

function walk(dir: string, relPrefix: string, depth: number, into: LibraryItem[]): void {
  if (depth > SCAN_MAX_DEPTH) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      const nextRel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
      walk(abs, nextRel, depth + 1, into);
      continue;
    }
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).toLowerCase();
    const k = kindOf(ext);
    if (!k) continue;
    let stat: fs.Stats;
    try { stat = fs.statSync(abs); } catch { continue; }
    into.push({
      filename: e.name,
      subfolder: relPrefix,
      ref: relPrefix ? `${relPrefix}/${e.name}` : e.name,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      kind: k,
    });
  }
}

/** List library items of a single kind, newest first, capped at LIST_LIMIT. */
export function listLibrary(kind: MediaKind): LibraryItem[] {
  const out: LibraryItem[] = [];
  walk(INPUT_DIR(), '', 0, out);
  return out
    .filter((it) => it.kind === kind)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, LIST_LIMIT);
}

/** Compose an absolute on-disk path inside input/ for a (subfolder, filename)
 *  pair, refusing anything that escapes input/. Returns null on traversal. */
export function resolveLibraryPath(subfolder: string, filename: string): string | null {
  const safeName = sanitizeSegment(filename);
  if (!safeName) return null;
  const root = INPUT_DIR();
  if (!subfolder) {
    const abs = path.join(root, safeName);
    return abs.startsWith(root + path.sep) ? abs : null;
  }
  const segs = subfolder.split('/')
    .map(sanitizeSegment)
    .filter((s): s is string => typeof s === 'string' && s.length > 0);
  if (segs.length === 0) return null;
  const abs = path.join(root, ...segs, safeName);
  return abs.startsWith(root + path.sep) ? abs : null;
}

export function deleteLibraryItem(subfolder: string, filename: string): boolean {
  const abs = resolveLibraryPath(subfolder, filename);
  if (!abs) return false;
  try {
    fs.rmSync(abs, { force: true });
    return true;
  } catch {
    return false;
  }
}
