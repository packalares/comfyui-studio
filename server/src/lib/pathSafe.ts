// Single source of truth for filesystem path safety.
//
// Any place that composes an on-disk path from caller-influenced parts — a
// ComfyUI `/api/view` URL's `subfolder`/`filename`, a media-library ref, a
// staged upload, a job-name-derived output filename — MUST route through here
// so a `../`, an absolute path, or a NUL byte can never escape its intended
// root or alter the path structure.
//
// This consolidates the containment idiom that was previously copy-pasted
// across viewPath / videoboard / videoboard-runners / mediaLibrary
// (`path.resolve(root, …)` followed by `abs.startsWith(root + sep)`), plus the
// per-segment sanitiser that used to live in viewPath.ts, into one audited
// module. It is also the shared rail the model file-ops work (move/delete)
// builds on.

import path from 'path';

/**
 * Validate ONE untrusted path segment (a subfolder or a filename) for use in
 * path composition. Returns the value unchanged when safe, or `null` when it
 * could redirect the composed path. `undefined` maps to `''` because an
 * omitted subfolder is legitimately empty.
 *
 * Note this permits a segment that itself contains `/` (a nested subfolder);
 * `resolveWithin` splits and re-checks each part, and the containment guard is
 * the backstop. Use {@link validateFilename} when a value must be exactly one
 * component (e.g. a write target).
 */
export function sanitizeSegment(value: string | undefined): string | null {
  if (value == null) return '';
  if (typeof value !== 'string') return null;
  if (value.includes('\0')) return null;                       // NUL truncation
  if (value.includes('..')) return null;                       // parent traversal
  if (value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value)) return null; // absolute
  return value;
}

/**
 * Validate a single FILENAME component destined for a write. Stricter than
 * {@link sanitizeSegment}: it must be exactly one component — no separators at
 * all — and not a special name. Returns the name when safe, else `null`.
 */
export function validateFilename(name: string | undefined): string | null {
  if (typeof name !== 'string' || name.length === 0) return null;
  if (name.includes('\0')) return null;
  if (name === '.' || name === '..') return null;
  if (name.includes('/') || name.includes('\\')) return null;
  if (path.isAbsolute(name)) return null;
  if (path.basename(name) !== name) return null;               // belt-and-braces
  return name;
}

/**
 * Resolve `segments` beneath `root` and assert the result stays inside `root`.
 * Each segment may contain `/`-separated parts (a nested subfolder); every
 * part is sanitised individually. Returns the absolute path, or `null` if any
 * part is unsafe or the composed path escapes `root`.
 *
 * `path.resolve` collapses `.`/`..` before the containment check, so an escape
 * attempt that slips a raw segment is still caught by the `startsWith` guard —
 * the two layers are deliberate defence in depth.
 */
export function resolveWithin(
  root: string | undefined,
  ...segments: (string | undefined)[]
): string | null {
  if (!root) return null;
  const rootAbs = path.resolve(root);
  const parts: string[] = [];
  for (const seg of segments) {
    if (seg == null || seg === '') continue;
    // Reject the whole segment first (catches `..`, an absolute path, a NUL),
    // THEN split a legitimately-nested subfolder into its parts.
    const safeSeg = sanitizeSegment(seg);
    if (safeSeg == null) return null;
    for (const piece of safeSeg.split('/')) {
      if (piece !== '') parts.push(piece);
    }
  }
  const abs = path.resolve(rootAbs, ...parts);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return null;
  return abs;
}
