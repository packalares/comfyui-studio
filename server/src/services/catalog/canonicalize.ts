// The single canonicalization gate every catalog write passes through.
//
// Goal: make EVERY catalog entry come out in the same shape, regardless of
// where the raw input came from (upstream seed / template import / user URL
// paste / auto-resolver). Once this gate runs, the dedup step can identify
// "same model" by `(save_path, filename)` because both sides have been
// normalized.
//
// Rules applied (in order):
//
//   1. Strip Windows drive prefixes from filename (`F:\...` → garbage,
//      can't recover, throw).
//   2. Normalize separators (backslashes → forward slashes).
//   3. Split filename into `prefix + basename`. The prefix is what the user
//      or upstream wrote as a sub-folder, e.g. `Wan/lightx2v_...` →
//      prefix=`Wan`, basename=`lightx2v_...`.
//   4. Decide the canonical `save_path` using disk truth:
//        a. Look for `<basename>` anywhere under any folder ComfyUI registered.
//        b. If found → use the folder + relative subdir from disk.
//        c. Else if `prefix` is a known ComfyUI folder → use prefix as save_path.
//        d. Else if `prefix` is non-empty → append it to the original save_path
//           (treat as user-intended subfolder).
//        e. Else → keep original save_path as-is.
//   5. Apply alias resolution: `clip` → `text_encoders`, `unet` →
//      `diffusion_models`, etc. (auto-discovered from the API).
//   6. Drop the `<huggingface>` placeholder pattern: rows with
//      `filename: "<huggingface>"` get migrated to use `hfRepo` (parsed from
//      `name` field) + a representative filename derived from disk.
//   7. Derive canonical `type` from save_path (via typeMap).
//   8. Flag rows whose save_path is registered with no known custom_node as
//      `pendingNodeInstall: true`.

import * as path from 'path';
import type { CatalogModel } from '../../contracts/catalog.contract.js';
import {
  canonicalFolderName, classifyFolder, findFileOnDisk, getKnownFolders,
  validateSavePath,
} from './folderRegistry.js';
import { canonicalType } from './typeMap.js';
import { logger } from '../../lib/logger.js';
import { normalizeModelFilename } from '../models/identity.js';

export interface CanonicalizeResult {
  entry: Partial<CatalogModel>;
  changed: boolean;
  /** True when the row references a folder no installed custom_node owns —
   *  UI can surface "pending node install" rather than treating as broken. */
  pendingNodeInstall?: boolean;
  /** Set when the row is unrecoverable garbage (e.g. Windows absolute path
   *  with no useful info). Caller decides drop vs preserve. */
  unrecoverable?: boolean;
  /** Human-readable note explaining what changed. For migration logs. */
  notes?: string[];
}

const WINDOWS_DRIVE_PREFIX = /^[A-Z]:[\\/]/;
const PLACEHOLDER_FILENAME = /^<[^>]+>$/;

/** Sync subset of canonicalize — handles every rule that doesn't require disk
 *  I/O. Used by `upsertModel` (called from request handlers, can't await a
 *  filesystem walk). Disk-truth resolution only kicks in for the async
 *  variant + the boot migration. */
export function canonicalizeSync(
  raw: Partial<CatalogModel>,
): CanonicalizeResult {
  const notes: string[] = [];
  const before = JSON.stringify(raw);
  const entry: Partial<CatalogModel> = { ...raw };

  if (PLACEHOLDER_FILENAME.test(entry.filename ?? '')) {
    const migrated = migratePlaceholder(entry);
    if (migrated) {
      Object.assign(entry, migrated);
      notes.push(`migrated placeholder → hfRepo=${migrated.hfRepo}`);
    } else {
      return {
        entry, changed: true, unrecoverable: true,
        notes: ['placeholder filename, no hfRepo hint'],
      };
    }
  }

  if (WINDOWS_DRIVE_PREFIX.test(entry.filename ?? '')) {
    return {
      entry, changed: true, unrecoverable: true,
      notes: [`windows absolute path: ${entry.filename}`],
    };
  }

  if (entry.filename) {
    const normalized = normalizeModelFilename(entry.filename);
    const lastSlash = normalized.lastIndexOf('/');
    if (lastSlash >= 0) {
      const prefix = normalized.slice(0, lastSlash).replace(/^models\//, '');
      const basename = normalized.slice(lastSlash + 1);
      entry.filename = basename;
      if (prefix) {
        // Sync rule: trust prefix as a sub-folder of the original save_path
        // (or as a save_path itself when prefix is a known folder).
        const top = prefix.split('/')[0];
        const aliased = canonicalFolderName(top);
        if (aliased !== top || getKnownFolders().has(top)) {
          entry.save_path = canonicalFolderName(prefix);
          notes.push(`prefix is folder: save_path → ${entry.save_path}`);
        } else if (entry.save_path) {
          const already = entry.save_path.split('/').includes(prefix.split('/')[0]);
          if (!already) {
            entry.save_path = `${entry.save_path}/${prefix}`;
            notes.push(`prefix kept as subfolder: ${entry.save_path}`);
          }
        }
      }
    }
  }

  if (entry.save_path) {
    // Validate against the type's registered folder list. If the save_path
    // names a folder ComfyUI actually scans for this type, keep it as-is
    // (allows legitimate subfolder organization like `loras/Flux1Dev`).
    // Otherwise fall back to the canonical folder for the type.
    const validated = validateSavePath(entry.save_path, entry.type);
    if (validated !== entry.save_path) {
      notes.push(`save_path validate: ${entry.save_path} → ${validated}`);
      entry.save_path = validated;
    }
  }

  const inferredType = canonicalType(entry.save_path);
  if (entry.type !== inferredType) {
    if (entry.type) notes.push(`type ${entry.type} → ${inferredType}`);
    entry.type = inferredType;
  }

  let pendingNodeInstall = false;
  if (entry.save_path && classifyFolder(entry.save_path) === 'unregistered') {
    pendingNodeInstall = true;
    notes.push(`unregistered folder ${entry.save_path}`);
  }

  const changed = JSON.stringify(entry) !== before;
  return { entry, changed, pendingNodeInstall, notes: notes.length ? notes : undefined };
}

export async function canonicalize(
  raw: Partial<CatalogModel>,
): Promise<CanonicalizeResult> {
  const notes: string[] = [];
  const before = JSON.stringify(raw);
  const entry: Partial<CatalogModel> = { ...raw };

  // ── 1. Filename rules ────────────────────────────────────────────────────
  const rawFilename = entry.filename ?? '';

  // 1a. Placeholder migration: <huggingface> rows carry the repo id in `name`.
  if (PLACEHOLDER_FILENAME.test(rawFilename)) {
    const migrated = migratePlaceholder(entry);
    if (migrated) {
      Object.assign(entry, migrated);
      notes.push(`migrated placeholder filename → hfRepo=${migrated.hfRepo}`);
    } else {
      // No name to recover from — drop it. The row's only purpose was as a
      // multi-file marker; without identity it can't be reinstated.
      return {
        entry, changed: true, unrecoverable: true,
        notes: ['placeholder filename with no recoverable hfRepo hint'],
      };
    }
  }

  // 1b. Windows absolute path: nothing recoverable, flag.
  if (WINDOWS_DRIVE_PREFIX.test(entry.filename ?? '')) {
    // We could keep just the basename, but the prefix usually encodes the
    // user's local install dir which we have no way to map. Drop.
    return {
      entry, changed: true, unrecoverable: true,
      notes: [`windows absolute path: ${entry.filename}`],
    };
  }

  // 1c. Normalize separators + split prefix/basename.
  if (entry.filename) {
    const normalized = normalizeModelFilename(entry.filename);
    const lastSlash = normalized.lastIndexOf('/');
    if (lastSlash >= 0) {
      const prefix = normalized.slice(0, lastSlash).replace(/^models\//, '');
      const basename = normalized.slice(lastSlash + 1);
      const resolvedSavePath = await resolveSavePath({
        basename,
        prefix,
        originalSavePath: entry.save_path ?? '',
      });
      entry.filename = basename;
      entry.save_path = resolvedSavePath.save_path;
      if (resolvedSavePath.note) notes.push(resolvedSavePath.note);
    }
  }

  // ── 2. save_path validation (against type's registered folders) ─────────
  if (entry.save_path) {
    const validated = validateSavePath(entry.save_path, entry.type);
    if (validated !== entry.save_path) {
      notes.push(`save_path validate: ${entry.save_path} → ${validated}`);
      entry.save_path = validated;
    }
  }

  // ── 3. type derivation ───────────────────────────────────────────────────
  const inferredType = canonicalType(entry.save_path);
  if (entry.type !== inferredType) {
    if (entry.type) notes.push(`type ${entry.type} → ${inferredType}`);
    entry.type = inferredType;
  }

  // ── 4. Flag unregistered save_paths ──────────────────────────────────────
  let pendingNodeInstall = false;
  if (entry.save_path) {
    const kind = classifyFolder(entry.save_path);
    if (kind === 'unregistered') {
      pendingNodeInstall = true;
      notes.push(`unregistered folder ${entry.save_path} — pending node install`);
    }
  }

  const changed = JSON.stringify(entry) !== before;
  return { entry, changed, pendingNodeInstall, notes: notes.length ? notes : undefined };
}

// ── Helpers ───────────────────────────────────────────────────────────────

interface ResolveSavePathInput {
  basename: string;
  prefix: string;
  originalSavePath: string;
}

interface ResolveSavePathResult {
  save_path: string;
  note?: string;
}

/** Decide what `save_path` should be after splitting a prefix off the
 *  filename. Disk truth wins; falls through to prefix-as-folder, then to
 *  appending prefix to the original save_path, then to keeping the original. */
async function resolveSavePath(input: ResolveSavePathInput): Promise<ResolveSavePathResult> {
  const { basename, prefix, originalSavePath } = input;

  // a. Disk truth — the file actually exists somewhere ComfyUI scans.
  try {
    const hit = await findFileOnDisk(basename);
    if (hit) {
      const save_path = hit.subPath ? `${hit.folder}/${hit.subPath}` : hit.folder;
      return {
        save_path,
        note: `resolved from disk: ${basename} → ${save_path}`,
      };
    }
  } catch (err) {
    logger.warn('canonicalize: disk lookup failed', {
      basename, message: err instanceof Error ? err.message : String(err),
    });
  }

  // b. prefix is a known ComfyUI folder → trust the prefix entirely.
  if (prefix) {
    const top = prefix.split('/')[0];
    if (getKnownFolders().has(canonicalFolderName(top).split('/')[0])
        || canonicalFolderName(top) !== top /* aliased to known */) {
      return {
        save_path: canonicalFolderName(prefix),
        note: `prefix is a known folder: save_path → ${prefix}`,
      };
    }
  }

  // c. prefix is something else (e.g. `wan2.2`) — preserve as a subfolder of
  //    the original save_path. User intent: "put loras/wan2.2/X here".
  if (prefix && originalSavePath) {
    // Strip duplicate prefix (audit case `bbox/face_yolov8m.pt` with
    // save_path `ultralytics/bbox` → don't end up at `ultralytics/bbox/bbox`).
    const already = originalSavePath.split('/').includes(prefix.split('/')[0]);
    const combined = already ? originalSavePath : `${originalSavePath}/${prefix}`;
    return {
      save_path: combined,
      note: `prefix kept as subfolder: ${originalSavePath} + ${prefix} → ${combined}`,
    };
  }

  // d. No useful info — leave the original save_path alone.
  return { save_path: originalSavePath };
}

interface PlaceholderMigration {
  hfRepo?: string;
  filename: string;
  save_path?: string;
}

function migratePlaceholder(entry: Partial<CatalogModel>): PlaceholderMigration | null {
  // Janus-Pro / FramePackI2V_HY rows have `name = "<owner>/<repo>"` (HF format)
  // and use `<huggingface>` as a marker filename. Extract the repo id and
  // pick a representative filename so disk-detection has something to match.
  const name = entry.name ?? '';
  if (/^[A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-]+$/.test(name)) {
    const repoBasename = name.split('/')[1];
    const save_path = entry.save_path
      ? `${entry.save_path.split('/')[0]}/${repoBasename}`
      : repoBasename;
    return {
      hfRepo: name,
      // Use `model.safetensors` as the canonical representative for sharded /
      // unsharded HF transformer repos. If the actual file is `pytorch_model.bin`
      // the next disk scan will reconcile.
      filename: 'model.safetensors',
      save_path,
    };
  }
  return null;
}

/** Group canonicalized rows by `(save_path, filename)` and merge duplicates.
 *  Returns the surviving row per group (richest metadata wins) plus the count
 *  of merged-away rows. Used by the migration step. */
export interface DedupResult {
  survivors: CatalogModel[];
  mergedAwayCount: number;
}

export function dedupRows(rows: CatalogModel[]): DedupResult {
  const groups = new Map<string, CatalogModel[]>();
  for (const r of rows) {
    if (!r.filename) continue;
    const key = `${r.save_path || ''}/${r.filename}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }

  const survivors: CatalogModel[] = [];
  let mergedAwayCount = 0;
  for (const list of groups.values()) {
    if (list.length === 1) {
      survivors.push(list[0]);
      continue;
    }
    const merged = mergeDuplicates(list);
    survivors.push(merged);
    mergedAwayCount += list.length - 1;
  }
  return { survivors, mergedAwayCount };
}

function mergeDuplicates(rows: CatalogModel[]): CatalogModel {
  // Score by metadata richness: longer description, more populated fields,
  // present hfRepo, present urlSources. Ties broken by insertion order.
  const ranked = [...rows].sort((a, b) => richnessScore(b) - richnessScore(a));
  const survivor: CatalogModel = { ...ranked[0] };

  const sourceSet = new Set<string>(survivor.source ? [survivor.source] : []);
  const urlSourcesByUrl = new Map<string, NonNullable<CatalogModel['urlSources']>[number]>();
  for (const u of survivor.urlSources ?? []) urlSourcesByUrl.set(u.url, u);

  for (const r of ranked.slice(1)) {
    if (r.source) sourceSet.add(r.source);
    for (const u of r.urlSources ?? []) {
      if (!urlSourcesByUrl.has(u.url)) urlSourcesByUrl.set(u.url, u);
    }
    if (r.url && !urlSourcesByUrl.has(r.url)) {
      urlSourcesByUrl.set(r.url, {
        url: r.url,
        host: 'hf' /* best-effort, normalized later */,
        declaredBy: r.source ?? 'seed',
      });
    }
    // Carry forward any field the survivor was missing.
    if (!survivor.description && r.description) survivor.description = r.description;
    if (!survivor.reference && r.reference) survivor.reference = r.reference;
    if (!survivor.base && r.base) survivor.base = r.base;
    if (!survivor.thumbnail && r.thumbnail) survivor.thumbnail = r.thumbnail;
    if (!survivor.hfRepo && r.hfRepo) survivor.hfRepo = r.hfRepo;
  }

  survivor.source = [...sourceSet].join('+');
  survivor.urlSources = [...urlSourcesByUrl.values()];
  // Re-mirror legacy `url` from the priority urlSource.
  if (survivor.urlSources[0]) survivor.url = survivor.urlSources[0].url;
  return survivor;
}

function richnessScore(r: CatalogModel): number {
  let s = 0;
  s += (r.description?.length ?? 0);
  s += (r.reference ? 50 : 0);
  s += (r.base ? 25 : 0);
  s += (r.hfRepo ? 100 : 0);
  s += (r.urlSources?.length ?? 0) * 20;
  s += (r.size_bytes ? 10 : 0);
  s += (r.thumbnail ? 15 : 0);
  return s;
}
