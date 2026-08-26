// Filesystem path helpers for the Videoboard feature.
// All paths resolve under <runtimeStateDir>/videoboard/.

import path from 'path';
import fs from 'fs';
import { paths } from '../../config/paths.js';
import { safeResolve } from '../../lib/fs.js';

function videoboardRoot(): string {
  return path.join(paths.runtimeStateDir, 'videoboard');
}

// projectId / charId / ext arrive from request params or upload filenames, so
// every path they compose runs through `safeResolve` — it throws if the
// result escapes the videoboard root (path-traversal guard).
export function projectDir(projectId: string): string {
  return safeResolve(videoboardRoot(), projectId);
}

export function audioPath(projectId: string, ext: string): string {
  return safeResolve(projectDir(projectId), `audio.${ext}`);
}

export function analysisJsonPath(projectId: string): string {
  return safeResolve(projectDir(projectId), 'analysis.json');
}

export function characterDir(charId: string): string {
  return safeResolve(videoboardRoot(), 'characters', charId);
}

export function characterRefPhotoPath(charId: string, n: number, ext: string): string {
  return safeResolve(characterDir(charId), `ref-${n}.${ext}`);
}

export function ensureProjectDir(projectId: string): void {
  fs.mkdirSync(projectDir(projectId), { recursive: true, mode: 0o700 });
}

export function ensureCharacterDir(charId: string): void {
  fs.mkdirSync(characterDir(charId), { recursive: true, mode: 0o700 });
}
