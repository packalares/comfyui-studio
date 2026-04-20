// Filesystem helpers shared across services + routes.
//
// `safeResolve` is the path-traversal guard every write/read inside a
// declared root MUST use. `statModelOnDisk` is the stat-fallback for
// install detection that was duplicated in `catalog.getMergedModels` and
// `check-dependencies`.

import fs from 'fs';
import path from 'path';

/**
 * Join `segments` under `root` and throw if the result escapes `root`.
 * Always returns an absolute, normalized path.
 */
export function safeResolve(root: string, ...segments: string[]): string {
  if (!root) throw new Error('safeResolve: empty root');
  const absRoot = path.resolve(root);
  const joined = path.resolve(absRoot, ...segments);
  const withSep = absRoot.endsWith(path.sep) ? absRoot : absRoot + path.sep;
  if (joined !== absRoot && !joined.startsWith(withSep)) {
    throw new Error(`Path escapes root: ${joined}`);
  }
  return joined;
}

/**
 * Check the filesystem for an installed model and return its size on disk,
 * or `null` if not present.
 *
 * The launcher's on-disk scan sometimes lags behind files placed by the
 * studio (e.g. via `download-custom`). Callers use this to avoid reporting
 * false "not installed" for such files.
 *
 * `saveDir` can be either category-only (`"checkpoints"`) or a full sub-path
 * (`"checkpoints/foo.safetensors"`); both forms are stat-checked.
 */
export function statModelOnDisk(
  root: string,
  saveDir: string | undefined,
  filename: string,
): number | null {
  if (!root || !saveDir) return null;
  // safeResolve throws on escape — a malicious saveDir like "../../etc" can't
  // leak stat info about files outside `root`. Treat a rejected candidate as
  // "not found" so callers fall through to the launcher scan.
  const candidates: string[] = [];
  try { candidates.push(safeResolve(root, saveDir, filename)); } catch { /* escape */ }
  try { candidates.push(safeResolve(root, saveDir)); } catch { /* escape */ }
  for (const p of candidates) {
    try {
      const st = fs.statSync(p);
      if (st.isFile()) return st.size;
    } catch {
      // missing: try the next candidate
    }
  }
  return null;
}

/**
 * Write `content` to `targetPath` atomically: write-to-temp then rename.
 * Creates the parent directory if it doesn't exist. Mode defaults to 0o600
 * for config-like files.
 */
export function atomicWrite(
  targetPath: string,
  content: string,
  opts: { mode?: number; dirMode?: number } = {},
): void {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true, mode: opts.dirMode ?? 0o700 });
  const tmp = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, { mode: opts.mode ?? 0o600 });
  fs.renameSync(tmp, targetPath);
}
