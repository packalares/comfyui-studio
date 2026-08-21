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
// Two roots now, with two very different lifecycles:
//   - `paths.comfyOutputDir/ace-step/` — generated song output (flac/mp3/wav
//     ACE-Step produces). This is OUTPUT: it lands in ComfyUI's own output
//     tree so the gallery's disk-sweep and the operator's normal output
//     backups cover it, and every song is also a `gallery` row (single
//     source of truth that the file exists) with `ace_songs` as its
//     metadata sidecar — see `routes/ace/generate.routes.ts`'s
//     `persistGeneratedSongs` and migration 0009. `saveGeneratedAudioToOutput`
//     below only writes the file; the caller builds + inserts the gallery
//     row (reusing `services/gallery/service.ts`'s insert path).
//   - `aceReferencesDir` — user-uploaded reference/source audio (cover mode,
//     audio2audio, extract-codes). This is INPUT, unrelated to the gallery,
//     and keeps living under `ACE_MUSIC_ROOT` as before.
// Every read/write resolves through `safeResolve` so a crafted key can never
// escape its root.

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { paths } from '../../config/paths.js';
import { safeResolve } from '../../lib/fs.js';
import { ValidationError } from '../../lib/errors.js';

/** Only `reference` audio is storage.ts-managed now — generated output
 *  lives in ComfyUI's output tree (see `saveGeneratedAudioToOutput`). Kept
 *  as a named type (rather than a bare string) so the `/ace/audio/:kind/:key`
 *  route and `audioPublicUrl`/`resolveAudioAbsPath`/`parseAudioUrl` stay
 *  self-documenting, and so a future kind (e.g. cover art) has an obvious
 *  place to slot in. */
export type AceAudioKind = 'reference';

// Route prefix these keys are served under — see `routes/ace/generate.routes.ts`'s
// GET /ace/audio/:kind/:key handler. Kept here so storage.ts is the single
// source of truth for the URL shape.
const AUDIO_URL_PREFIX = '/api/ace/audio';

function dirForKind(_kind: AceAudioKind): string {
  return paths.aceReferencesDir;
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
 * raw ACE-Step URL passed straight through as a reference, or a gallery
 * `/api/view` URL — generated song audio is served through the gallery now,
 * not through this prefix).
 */
export function parseAudioUrl(url: string): { kind: AceAudioKind; key: string } | null {
  const m = new RegExp(`^${AUDIO_URL_PREFIX}/(reference)/([^/]+)$`).exec(url);
  if (!m) return null;
  return { kind: m[1] as AceAudioKind, key: decodeURIComponent(m[2]) };
}

export interface StoredAudio {
  kind: AceAudioKind;
  key: string;
  url: string;
  absPath: string;
}

/** Subfolder (under `paths.comfyOutputDir`) generated song audio lands in —
 *  matches the `subfolder` param on the `/api/view` URL the gallery row
 *  stores, and what `services/gallery/diskSweep.ts` would find on its own if
 *  it ever had to reconcile these files. */
export const GENERATED_AUDIO_SUBFOLDER = 'ace-step';

export interface SavedOutputAudio {
  filename: string;
  subfolder: string;
  /** `/api/view?...` URL — the same shape every other gallery row uses,
   *  resolved locally by `routes/view.routes.ts` via `resolveViewPath`. */
  url: string;
  absPath: string;
}

/**
 * Persist generated song audio directly into ComfyUI's output tree
 * (`<comfyOutputDir>/ace-step/`) rather than under `ACE_MUSIC_ROOT`, so the
 * gallery disk-sweep and the operator's output backups cover it. Does NOT
 * touch the DB — the caller (`persistGeneratedSongs`) builds the gallery row
 * and inserts it (+ the `ace_songs` sidecar row) in one transaction.
 * `ext` includes the leading dot (e.g. `.flac`).
 */
export async function saveGeneratedAudioToOutput(
  songId: string,
  index: number,
  buffer: Buffer,
  ext: string,
): Promise<SavedOutputAudio> {
  if (!paths.comfyOutputDir) {
    throw new ValidationError('COMFYUI_PATH is not configured — cannot save generated audio');
  }
  const filename = `${songId}_${index}${ext}`;
  const subfolder = GENERATED_AUDIO_SUBFOLDER;
  const absPath = safeResolve(paths.comfyOutputDir, subfolder, filename);
  await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
  await fs.promises.writeFile(absPath, buffer);
  const url = `/api/view?filename=${encodeURIComponent(filename)}`
    + `&subfolder=${encodeURIComponent(subfolder)}&type=output`;
  return { filename, subfolder, url, absPath };
}

/**
 * Persist a separated stem into the output tree, alongside generated songs.
 *
 * Deliberately the SAME tree rather than the private reference store: a stem
 * is only useful if you can then feed it back in — remix the drums, use the
 * vocal as a "sound like" reference — and the media picker browses comfy
 * outputs. Writing it anywhere else would produce files the rest of the app
 * can't see.
 */
export async function saveStemAudio(
  baseName: string,
  stemName: string,
  buffer: Buffer,
  ext: string,
): Promise<SavedOutputAudio> {
  if (!paths.comfyOutputDir) {
    throw new ValidationError('COMFYUI_PATH is not configured — cannot save stems');
  }
  // Randomised suffix: two separations of the same track must not overwrite
  // each other, and the source filename is never trusted as a path component.
  const safeBase = baseName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60);
  const filename = `${safeBase}_${stemName}_${randomUUID().slice(0, 8)}${ext}`;
  const subfolder = `${GENERATED_AUDIO_SUBFOLDER}/stems`;
  const absPath = safeResolve(paths.comfyOutputDir, subfolder, filename);
  await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
  await fs.promises.writeFile(absPath, buffer);
  const url = `/api/view?filename=${encodeURIComponent(filename)}`
    + `&subfolder=${encodeURIComponent(subfolder)}&type=output`;
  return { filename, subfolder, url, absPath };
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
