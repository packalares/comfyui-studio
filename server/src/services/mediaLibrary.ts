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
const OUTPUT_DIR = (): string => path.join(env.COMFYUI_PATH, 'output');
const LIST_LIMIT = 200;
const SCAN_MAX_DEPTH = 4;

export type Scope = 'input' | 'output';

/** Symlink name created inside input/ that points at output/. Lets standard
 *  comfy loaders (LoadImage, LoadAudio, LoadVideo, etc.) resolve `<this>/...`
 *  refs without any workflow change — no per-file copy, one symlink total. */
export const OUTPUT_LINK_NAME = 'output_load';

function rootForScope(scope: Scope): string {
  return scope === 'output' ? OUTPUT_DIR() : INPUT_DIR();
}

/**
 * Ensure `input/output_load` is a symlink to `output/`. Idempotent — leaves
 * existing correct symlinks alone, logs a warning if a real file/dir is
 * blocking the path (we never clobber user data). Cheap enough to call at
 * every server start AND on first output-scope list.
 */
export function ensureOutputInputSymlink(): void {
  const linkPath = path.join(INPUT_DIR(), OUTPUT_LINK_NAME);
  const targetPath = OUTPUT_DIR();
  try {
    const stat = fs.lstatSync(linkPath, { throwIfNoEntry: false } as fs.StatSyncOptions);
    if (stat) {
      if (stat.isSymbolicLink()) {
        const current = fs.readlinkSync(linkPath);
        // Already pointing at the right place — no-op.
        if (current === targetPath || path.resolve(path.dirname(linkPath), current) === targetPath) {
          return;
        }
        // Wrong target — replace.
        fs.unlinkSync(linkPath);
      } else {
        // A real file or directory is sitting at the symlink path. Do not
        // clobber — could be user content. The output-source listing will
        // still work via the scope-rewrite below, but standard LoadImage
        // won't be able to resolve `output_load/...` refs until the user
        // moves the conflicting entry out of the way.
        return;
      }
    }
    fs.mkdirSync(INPUT_DIR(), { recursive: true });
    fs.symlinkSync(targetPath, linkPath, 'dir');
  } catch {
    // Swallow — non-fatal. Output browsing still works server-side; only
    // the comfy-load step would be affected, and the user can always
    // re-pick from input/ instead.
  }
}

export function subfolderForKind(kind: MediaKind): string {
  return SUBFOLDER_BY_KIND[kind];
}

export function extsFor(kind: MediaKind): Set<string> {
  return EXTS_BY_KIND[kind];
}

export interface LibraryItem {
  filename: string;
  /** Empty for files at the root. Otherwise the relative path (e.g. "images"). */
  subfolder: string;
  /** `<subfolder>/<filename>` if subfolder set, else just filename. The form
   *  ComfyUI's LoadImage / LoadAudio nodes expect on submit. */
  ref: string;
  sizeBytes: number;
  /** Modification time in ms since epoch. */
  mtimeMs: number;
  kind: MediaKind;
  /** Whether this file lives under `input/` or `output/`. Consumers wiring
   *  the picked file into a workflow widget use this to decide between the
   *  standard LoadImage (input) and an output-aware loader. Defaults to
   *  'input' for back-compat with existing callers. */
  source: Scope;
}

function kindOf(ext: string): MediaKind | null {
  if (EXTS_BY_KIND.image.has(ext)) return 'image';
  if (EXTS_BY_KIND.audio.has(ext)) return 'audio';
  if (EXTS_BY_KIND.video.has(ext)) return 'video';
  return null;
}

function walk(dir: string, relPrefix: string, depth: number, scope: Scope, into: LibraryItem[]): void {
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
      walk(abs, nextRel, depth + 1, scope, into);
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
      source: scope,
    });
  }
}

/** List library items of a single kind, newest first, capped at LIST_LIMIT.
 *  `scope` selects the root: `'input'` (default — pickable inputs the user
 *  manages) or `'output'` (read-only browse of past generations).
 *
 *  For `scope='output'`, every item's `subfolder` and `ref` are prefixed
 *  with `output_load/` so the returned ref is a comfy-resolvable
 *  input-relative path. Combined with the `input/output_load → output`
 *  symlink (see `ensureOutputInputSymlink`), standard LoadImage /
 *  LoadAudio / LoadVideo nodes pick up output files unchanged. */
export function listLibrary(kind: MediaKind, scope: Scope = 'input'): LibraryItem[] {
  if (scope === 'output') ensureOutputInputSymlink();
  const out: LibraryItem[] = [];
  walk(rootForScope(scope), '', 0, scope, out);
  const filtered = out
    .filter((it) => it.kind === kind)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, LIST_LIMIT);
  if (scope === 'input') return filtered;
  // Rewrite output items so their refs sit under `input/output_load/...`.
  return filtered.map((it) => {
    const prefixedSubfolder = it.subfolder ? `${OUTPUT_LINK_NAME}/${it.subfolder}` : OUTPUT_LINK_NAME;
    const prefixedRef = `${prefixedSubfolder}/${it.filename}`;
    return { ...it, subfolder: prefixedSubfolder, ref: prefixedRef };
  });
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
