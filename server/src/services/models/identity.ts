// Canonical model identity — single source of truth for filename
// normalization and (save_path, filename) comparison.
//
// All consumer modules must route through these helpers rather than
// inlining regex replaces or ad-hoc `===` comparisons. This ensures
// that Windows-authored workflows, CivitAI, HuggingFace, and on-disk
// scanner entries all hash + compare with the same logic.

import { TYPE_TO_DIR } from './typeMap.js';

/** Forward-slash, no leading slash, case-preserved as on disk. */
export type ModelIdentity = {
  /** Forward-slash, no leading slash, lowercased-extension-preserved as on disk. */
  filename: string;
  /** Subfolder relative to ComfyUI's models/ root, no leading slash, no trailing slash.
   *  Empty string allowed for root-level files. */
  save_path: string;
  /** Optional SHA256 of the file's bytes (lowercase hex, 64 chars). When present,
   *  takes precedence over (save_path, filename) for identity in non-disk operations. */
  sha256?: string;
};

/**
 * Normalize a raw filename from any source (Windows workflow widget, CivitAI,
 * HF tree). Strips backslashes, collapses doubled slashes, strips leading slash.
 * Does NOT lowercase the extension — preserves case.
 */
export function normalizeModelFilename(raw: string): string {
  let s = raw;
  // 1. Windows backslashes → forward slashes.
  s = s.replace(/\\/g, '/');
  // 2. Collapse doubled (or more) slashes.
  s = s.replace(/\/+/g, '/');
  // 3. Strip leading slash.
  s = s.replace(/^\/+/, '');
  return s;
}

/**
 * Resolve `save_path` sentinels to a real folder name.
 *
 * Upstream ComfyUI-Manager (model-list.json) uses the literal string
 * `"default"` as a save_path sentinel meaning "use the canonical folder
 * for the model's `type`" — e.g. `type: "upscale"` + `save_path: "default"`
 * → `upscale_models`. About 19 of their ~540 entries use this.
 *
 * Without resolution, the user's catalog row (which stores the RESOLVED
 * folder name like `"upscale_models"` after install) and the upstream
 * Manager row (still `"default"`) hash to different dedup keys and the
 * SAME model shows as TWO rows in the merged Models list.
 *
 * We normalise here so every consumer that builds an identity key sees
 * one canonical value. Returns the input unchanged when no resolution
 * applies (no type, type not in TYPE_TO_DIR, or save_path is not the
 * sentinel).
 */
export function resolveSavePathSentinel(
  save_path: string | undefined,
  type?: string,
): string {
  const sp = save_path ?? '';
  if (sp !== 'default' || !type) return sp;
  return TYPE_TO_DIR[type] ?? sp;
}

/**
 * Build a stable string key for a (save_path, filename) pair.
 * Used for deduplication keys — never persisted.
 *
 * Pass `type` so the helper can resolve ComfyUI-Manager's `"default"`
 * sentinel to the canonical folder (see `resolveSavePathSentinel`).
 */
export function pairKey(id: { save_path?: string; filename: string; type?: string }): string {
  const sp = resolveSavePathSentinel(id.save_path, id.type);
  return sp ? `${sp}/${id.filename}` : id.filename;
}

/**
 * Compare two identities for equality. Honors sha256 when both have it.
 * Otherwise compares (save_path, filename) case-sensitively, with an
 * optional case-insensitive fallback when `opts.caseInsensitive` is true.
 */
export function identityEquals(
  a: ModelIdentity,
  b: ModelIdentity,
  opts?: { caseInsensitive?: boolean },
): boolean {
  // SHA256 takes strict precedence when both sides carry it.
  if (a.sha256 && b.sha256) {
    return a.sha256.toLowerCase() === b.sha256.toLowerCase();
  }

  // Exact (save_path, filename) comparison.
  const exactFilename = a.filename === b.filename;
  const exactSavePath = (a.save_path || '') === (b.save_path || '');
  if (exactFilename && exactSavePath) return true;

  // Case-insensitive fallback when requested.
  if (opts?.caseInsensitive) {
    const ciFilename = a.filename.toLowerCase() === b.filename.toLowerCase();
    const ciSavePath = (a.save_path || '').toLowerCase() === (b.save_path || '').toLowerCase();
    return ciFilename && ciSavePath;
  }

  return false;
}

/**
 * Best-effort identity from any catalog row / scan entry.
 * Handles legacy shapes (name-only entries from essentialModels) gracefully.
 * Returns null when no filename can be derived.
 */
export function identityFrom(row: {
  filename?: string;
  name?: string;
  save_path?: string;
  sha256?: string;
}): ModelIdentity | null {
  const raw = row.filename || row.name;
  if (!raw || raw.trim() === '') return null;

  // If the value looks like a path (contains a slash or backslash after
  // normalization), use only the basename as the filename.
  const normalized = normalizeModelFilename(raw);
  const lastSlash = normalized.lastIndexOf('/');
  const filename = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;

  if (!filename) return null;

  return {
    filename,
    save_path: row.save_path ?? '',
    sha256: row.sha256,
  };
}
