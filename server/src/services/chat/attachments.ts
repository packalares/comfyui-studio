// Chat attachment persistence. Moves inline base64 `data:` URLs from chat
// message `parts` to disk so the SQLite DB doesn't balloon with image bytes.
//
// Layout: ~/.config/comfyui-studio/runtime/chat-attachments/<msgId>-<hash12>.<ext>
// Served via GET /api/chat/attachments/:filename.

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { paths } from '../../config/paths.js';
import { logger } from '../../lib/logger.js';
import { getDb } from '../../lib/db/connection.js';

const ATTACH_SUBDIR = 'chat-attachments';
const ATTACH_URL_PREFIX = '/api/chat/attachments/';

/** Absolute path to the chat-attachments storage directory. */
export function attachmentDir(): string {
  return path.join(paths.runtimeStateDir, ATTACH_SUBDIR);
}

function ensureDir(): void {
  fs.mkdirSync(attachmentDir(), { recursive: true, mode: 0o700 });
}

/** MIME type → file extension mapping. */
function extFromMime(mime: string): string {
  const m = mime.toLowerCase().split(';')[0].trim();
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
    'image/tiff': 'tiff',
    'image/svg+xml': 'svg',
  };
  return map[m] ?? 'bin';
}

/** Parse a data URL, return buffer + mime. Returns null for non-data URLs. */
function parseDataUrl(url: string): { buf: Buffer; mime: string } | null {
  if (!url.startsWith('data:')) return null;
  const comma = url.indexOf(',');
  if (comma < 0) return null;
  const header = url.slice(5, comma); // e.g. "image/png;base64"
  const parts = header.split(';');
  const mime = parts[0] ?? '';
  const encoding = parts[1] ?? '';
  const raw = url.slice(comma + 1);
  if (encoding !== 'base64') return null;
  try {
    const buf = Buffer.from(raw, 'base64');
    return { buf, mime };
  } catch {
    return null;
  }
}

export interface FilePart {
  type: 'file';
  mediaType?: string;
  url?: string;
  name?: string;
  [k: string]: unknown;
}

type Part = FilePart | Record<string, unknown>;

export interface ExtractResult {
  rewrittenParts: Part[];
  savedFiles: string[];
}

/**
 * For each `{ type: 'file', url: 'data:...' }` part, write the bytes to disk
 * and replace the URL with `/api/chat/attachments/<filename>`. Non-data URLs
 * pass through unchanged. Idempotent: same msgId + same content hash reuses
 * the existing file without re-writing.
 */
export function extractAndPersistAttachments(
  msgId: string,
  parts: Part[],
): ExtractResult {
  const savedFiles: string[] = [];
  const rewrittenParts: Part[] = parts.map((part) => {
    if (
      !part
      || typeof part !== 'object'
      || (part as { type?: unknown }).type !== 'file'
    ) return part;
    const fp = part as FilePart;
    const url = fp.url ?? '';
    if (!url.startsWith('data:')) return part;

    const parsed = parseDataUrl(url);
    if (!parsed) return part;

    const { buf, mime } = parsed;
    const hash12 = createHash('sha256').update(buf).digest('hex').slice(0, 12);
    const ext = extFromMime(mime || fp.mediaType || '');
    const filename = `${msgId}-${hash12}.${ext}`;
    const filePath = path.join(attachmentDir(), filename);

    try {
      ensureDir();
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, buf, { mode: 0o600 });
      }
      savedFiles.push(filename);
      return { ...fp, url: `${ATTACH_URL_PREFIX}${filename}` };
    } catch (err) {
      logger.warn('chat attachments: failed to persist file', {
        msgId, hash: hash12, error: String(err),
      });
      return part; // keep inline on error so the message still renders
    }
  });

  return { rewrittenParts, savedFiles };
}

/**
 * Given the `parts` arrays of messages being deleted, unlink any files
 * referenced by `/api/chat/attachments/` URLs. Best-effort; ENOENT is ignored.
 * Returns the count of files successfully deleted.
 */
export function deleteAttachmentsForMessages(
  partArrays: Part[][],
): number {
  let count = 0;
  for (const parts of partArrays) {
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      const fp = part as FilePart;
      const url = fp.url ?? '';
      if (!url.startsWith(ATTACH_URL_PREFIX)) continue;
      const filename = url.slice(ATTACH_URL_PREFIX.length);
      // Safety: reject traversal attempts even during cleanup
      if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) continue;
      const filePath = path.join(attachmentDir(), path.basename(filename));
      try {
        fs.unlinkSync(filePath);
        count++;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          logger.warn('chat attachments: cleanup unlink failed', {
            filename, error: String(err),
          });
        }
      }
    }
  }
  return count;
}

/**
 * Scan attachmentDir() for files older than 7 days that are NOT referenced by
 * any current chat_messages.parts row. Best-effort; never throws.
 */
export function sweepOrphanedAttachments(): void {
  const dir = attachmentDir();
  if (!fs.existsSync(dir)) return;

  const TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - TTL_MS;

  let referenced: Set<string>;
  try {
    const db = getDb();
    const rows = db.prepare('SELECT parts FROM chat_messages').all() as { parts: string }[];
    referenced = new Set<string>();
    for (const row of rows) {
      try {
        const parts = JSON.parse(row.parts) as Part[];
        for (const part of parts) {
          if (!part || typeof part !== 'object') continue;
          const url = (part as FilePart).url ?? '';
          if (url.startsWith(ATTACH_URL_PREFIX)) {
            referenced.add(url.slice(ATTACH_URL_PREFIX.length));
          }
        }
      } catch { /* skip malformed parts */ }
    }
  } catch (err) {
    logger.warn('chat attachments sweep: DB scan failed', { error: String(err) });
    return;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (referenced.has(entry.name)) continue;
    try {
      const stat = fs.statSync(path.join(dir, entry.name));
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(path.join(dir, entry.name));
      }
    } catch { /* best-effort */ }
  }
}
