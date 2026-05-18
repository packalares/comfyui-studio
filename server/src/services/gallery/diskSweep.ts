// Disk-sweep orphan importer.
//
// Walks ComfyUI's output directory and inserts bare gallery rows for files
// that are not already represented in the gallery table. This covers files
// written while the Studio backend was offline, or generated via ComfyUI's
// native editor.
//
// Intentionally minimal: no PNG tEXt parsing, no FLAC Vorbis comment
// reading, no EXIF. Rich metadata (workflowJson, promptText, seed, etc.)
// comes exclusively from the live-pipeline path so there's never a mixed-
// quality row set where some "parsed" fields are guesses and others come
// from ComfyUI's authoritative history entry.

import { access, readdir } from 'fs/promises';
import type { Dirent } from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { paths } from '../../config/paths.js';
import { detectMediaType } from '../../lib/mediaType.js';
import * as repo from '../../lib/db/gallery.repo.js';
import { getDb } from '../../lib/db/connection.js';
import { logger } from '../../lib/logger.js';
import { inspectFile } from './fileInspect.js';

// ─── Extension allow-list ─────────────────────────────────────────────────────

const ALLOWED_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'webp', 'gif',   // images
  'mp4', 'webm', 'mov', 'mkv',           // video
  'flac', 'wav', 'mp3', 'ogg', 'opus',   // audio
  'glb', 'gltf', 'obj', 'ply',           // 3D
]);

// Files whose exact name should always be skipped regardless of extension.
const SKIP_NAMES = new Set([
  '_output_images_will_be_put_here',
]);

const MAX_RECURSE_DEPTH = 8;

// ─── Existing-key set ─────────────────────────────────────────────────────────

/**
 * Return a Set of `subfolder|filename` composite keys for every row
 * already in the gallery. Used for O(1) dedupe during the disk walk.
 * Only selects the two columns needed — avoids loading fat fields.
 */
function loadExistingKeys(db: Database.Database): Set<string> {
  const rows = db
    .prepare('SELECT subfolder, filename FROM gallery')
    .all() as Array<{ subfolder: string; filename: string }>;
  const set = new Set<string>();
  for (const r of rows) {
    set.add(`${r.subfolder ?? ''}|${r.filename}`);
  }
  return set;
}

// ─── Recursive walk ───────────────────────────────────────────────────────────

interface WalkResult {
  inserted: number;
  scanned: number;
}

async function walkDir(
  dirPath: string,
  subfolder: string,
  depth: number,
  existingKeys: Set<string>,
  result: WalkResult,
): Promise<void> {
  if (depth > MAX_RECURSE_DEPTH) return;

  let entries: Dirent[];
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    logger.warn('diskSweep: readdir failed', {
      dir: dirPath,
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  for (const entry of entries) {
    // Skip hidden files and OS metadata (e.g. .DS_Store).
    if (entry.name.startsWith('.')) continue;

    if (entry.isSymbolicLink()) {
      // Skip symlinked directories to avoid following loops.
      continue;
    }

    if (entry.isDirectory()) {
      const childSubfolder = subfolder ? `${subfolder}/${entry.name}` : entry.name;
      // Skip ComfyUI's ephemeral preview folder at any depth.
      if (childSubfolder === 'temp' || childSubfolder.startsWith('temp/')) continue;
      await walkDir(
        path.join(dirPath, entry.name),
        childSubfolder,
        depth + 1,
        existingKeys,
        result,
      );
      continue;
    }

    if (!entry.isFile()) continue;

    result.scanned += 1;

    const filename = entry.name;

    // Skip exact-name blocklist.
    if (SKIP_NAMES.has(filename)) continue;

    // Skip metadata sidecars.
    if (filename.endsWith('.meta.json')) continue;

    // Skip latent files.
    const dotIdx = filename.lastIndexOf('.');
    const ext = dotIdx >= 0 ? filename.slice(dotIdx + 1).toLowerCase() : '';
    if (ext === 'latent') continue;

    // Extension allow-list filter.
    if (!ALLOWED_EXTS.has(ext)) continue;

    // Dedupe against existing gallery rows.
    const key = `${subfolder}|${filename}`;
    if (existingKeys.has(key)) continue;

    // inspectFile provides the same stat-and-zero-byte check the old inline
    // code did, now shared with the live pipeline path. Using the shared helper
    // keeps bucket-3 probes (sharp, ffprobe) in one place to grow.
    const absPath = path.join(dirPath, filename);
    const inspection = await inspectFile(absPath);
    if (!inspection) continue;

    // Build a bare orphan id: `disk-<random uuid>`. Single URL path segment,
    // no slash / colon / dot — so every gallery route (`/api/gallery/:id`,
    // `/api/thumbnail/:galleryId`, ...) matches it unambiguously even when a
    // reverse proxy decodes `%2F` to `/` in transit. Dedup against existing
    // rows is keyed on (subfolder, filename), not on the id, so generating a
    // fresh UUID on every sweep is fine.
    const id = `disk-${randomUUID()}`;

    const url =
      `/api/view?filename=${encodeURIComponent(filename)}` +
      `&subfolder=${encodeURIComponent(subfolder)}` +
      `&type=output`;

    const row: repo.GalleryRow = {
      id,
      filename,
      subfolder,
      type: 'output',
      mediaType: detectMediaType(filename),
      url,
      promptId: '',
      createdAt: Math.floor(inspection.mtimeMs),
      sizeBytes: inspection.sizeBytes,
      templateName: null,
      // All rich metadata fields are intentionally absent. Orphan rows stay
      // minimal forever; the live pipeline is the only authoritative source
      // for workflowJson, promptText, seed, etc.
    };

    const didInsert = repo.insertGalleryRow(row);
    if (didInsert) {
      result.inserted += 1;
      // Mark as known so a second encounter of the same file within this
      // sweep (e.g. via two directory entries pointing at the same name
      // in different subdirs) doesn't try to insert again.
      existingKeys.add(key);
    }
  }
}

// ─── Public entry point ───────────────────────────────────────────────────────

export interface SweepResult {
  inserted: number;
  scanned: number;
}

/**
 * Walk the ComfyUI output directory and insert bare gallery rows for any
 * files not already present. Pass `rootOverride` to redirect the sweep
 * (used by tests so they don't depend on a real ComfyUI installation).
 */
export async function sweepOrphansFromDisk(rootOverride?: string): Promise<SweepResult> {
  const root = rootOverride ?? paths.comfyOutputDir;

  if (!root) {
    logger.warn('diskSweep: comfyOutputDir is not configured; skipping sweep');
    return { inserted: 0, scanned: 0 };
  }

  try {
    await access(root);
  } catch {
    logger.warn('diskSweep: output dir is missing or unreadable', { root });
    return { inserted: 0, scanned: 0 };
  }

  const db = getDb();
  const existingKeys = loadExistingKeys(db);
  const result: WalkResult = { inserted: 0, scanned: 0 };

  await walkDir(root, '', 0, existingKeys, result);

  return result;
}
