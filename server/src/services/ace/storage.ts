// Local filesystem storage for ACE-Step music assets.
//
// Ported from ace-step-ui's `services/storage/local.ts` (the only provider
// ace-step-ui ever actually used — its S3 "factory" abstraction is dropped;
// see `getStorageProvider` there, which always returned `LocalStorageProvider`
// regardless of config). comfy has no S3/remote-storage layer to plug into
// here, so this module is deliberately a flat function set (matching the repo
// pattern elsewhere in `lib/db/*.repo.ts`) rather than a provider interface
// with only one implementation.
//
// Two roots (see `config/paths.ts`):
//   - `aceAudioDir`      — generated song output (flac/mp3/wav ACE-Step produces).
//   - `aceReferencesDir` — user-uploaded reference/source audio (cover mode,
//                          audio2audio, extract-codes).
// Every read/write resolves through `safeResolve` so a crafted key can never
// escape its root.

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { paths } from '../../config/paths.js';
import { safeResolve } from '../../lib/fs.js';
import { ValidationError } from '../../lib/errors.js';

export type AceAudioKind = 'output' | 'reference';

// Route prefix these keys are served under — see `routes/ace/generate.routes.ts`'s
// GET /ace/audio/:kind/:key handler. Kept here so storage.ts is the single
// source of truth for the URL shape.
const AUDIO_URL_PREFIX = '/api/ace/audio';

function dirForKind(kind: AceAudioKind): string {
  return kind === 'output' ? paths.aceAudioDir : paths.aceReferencesDir;
}

/** Reject any key that isn't a plain filename before it ever reaches safeResolve. */
function assertPlainFilename(key: string): void {
  if (!key || key.includes('/') || key.includes('\\') || key.includes('..')) {
    throw new ValidationError('Invalid audio key');
  }
}

export function audioPublicUrl(kind: AceAudioKind, key: string): string {
  assertPlainFilename(key);
  return `${AUDIO_URL_PREFIX}/${kind}/${encodeURIComponent(key)}`;
}

/** Resolve a `(kind, key)` pair to an absolute path, guarding traversal. */
export function resolveAudioAbsPath(kind: AceAudioKind, key: string): string {
  assertPlainFilename(key);
  return safeResolve(dirForKind(kind), key);
}

/**
 * Parse a URL previously returned by `audioPublicUrl` back into
 * `{ kind, key }`. Returns null for anything that isn't one of ours (e.g. a
 * raw ACE-Step URL passed straight through as a reference).
 */
export function parseAudioUrl(url: string): { kind: AceAudioKind; key: string } | null {
  const m = new RegExp(`^${AUDIO_URL_PREFIX}/(output|reference)/([^/]+)$`).exec(url);
  if (!m) return null;
  return { kind: m[1] as AceAudioKind, key: decodeURIComponent(m[2]) };
}

export interface StoredAudio {
  kind: AceAudioKind;
  key: string;
  url: string;
  absPath: string;
}

/** Persist generated song audio. `ext` includes the leading dot (e.g. `.flac`). */
export async function saveGeneratedAudio(
  songId: string,
  index: number,
  buffer: Buffer,
  ext: string,
): Promise<StoredAudio> {
  const key = `${songId}_${index}${ext}`;
  const absPath = resolveAudioAbsPath('output', key);
  await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
  await fs.promises.writeFile(absPath, buffer);
  return { kind: 'output', key, url: audioPublicUrl('output', key), absPath };
}

/** Persist an uploaded reference/source audio file. Key is randomised — the
 *  original filename is never trusted as a path component. */
export async function saveReferenceAudio(buffer: Buffer, ext: string): Promise<StoredAudio> {
  const key = `${Date.now()}-${randomUUID()}${ext}`;
  const absPath = resolveAudioAbsPath('reference', key);
  await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
  await fs.promises.writeFile(absPath, buffer);
  return { kind: 'reference', key, url: audioPublicUrl('reference', key), absPath };
}

/** Delete by (kind, key). Missing file is a silent no-op (ENOENT swallowed),
 *  matching ace-step-ui's LocalStorageProvider.delete. */
export async function deleteAudio(kind: AceAudioKind, key: string): Promise<void> {
  const absPath = resolveAudioAbsPath(kind, key);
  try {
    await fs.promises.unlink(absPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw err;
  }
}

/** Delete by a previously-issued public URL. No-op for URLs storage.ts didn't
 *  mint (e.g. a raw external reference URL never persisted locally). */
export async function deleteAudioByUrl(url: string): Promise<void> {
  const parsed = parseAudioUrl(url);
  if (!parsed) return;
  await deleteAudio(parsed.kind, parsed.key);
}

export async function readAudioBuffer(kind: AceAudioKind, key: string): Promise<Buffer> {
  return fs.promises.readFile(resolveAudioAbsPath(kind, key));
}

export function audioExists(kind: AceAudioKind, key: string): boolean {
  try {
    return fs.statSync(resolveAudioAbsPath(kind, key)).isFile();
  } catch {
    return false;
  }
}

const MIME_BY_EXT: Record<string, string> = {
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.mp3': 'audio/mpeg',
  '.aac': 'audio/aac',
  '.m4a': 'audio/mp4',
};

export function mimeTypeForExt(ext: string): string {
  return MIME_BY_EXT[ext.toLowerCase()] ?? 'application/octet-stream';
}
