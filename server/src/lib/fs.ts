// Filesystem helpers shared across services + routes.
//
// `safeResolve` is the path-traversal guard every write/read inside a
// declared root MUST use.

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
