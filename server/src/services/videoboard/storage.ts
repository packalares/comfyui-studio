// Filesystem path helpers for the Videoboard feature.
// All paths resolve under <runtimeStateDir>/videoboard/.

import path from 'path';
import fs from 'fs';
import { paths } from '../../config/paths.js';

function videoboardRoot(): string {
  return path.join(paths.runtimeStateDir, 'videoboard');
}

export function projectDir(projectId: string): string {
  return path.join(videoboardRoot(), projectId);
}

export function audioPath(projectId: string, ext: string): string {
  return path.join(projectDir(projectId), `audio.${ext}`);
}

export function analysisJsonPath(projectId: string): string {
  return path.join(projectDir(projectId), 'analysis.json');
}

export function characterDir(charId: string): string {
  return path.join(videoboardRoot(), 'characters', charId);
}

export function characterRefPhotoPath(charId: string, n: number, ext: string): string {
  return path.join(characterDir(charId), `ref-${n}.${ext}`);
}

export function ensureProjectDir(projectId: string): void {
  fs.mkdirSync(projectDir(projectId), { recursive: true, mode: 0o700 });
}

export function ensureCharacterDir(charId: string): void {
  fs.mkdirSync(characterDir(charId), { recursive: true, mode: 0o700 });
}
