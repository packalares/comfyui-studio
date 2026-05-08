// Chat attachment persistence. File bytes live on disk under
// `runtime/chat-attachments/<id>.<ext>`; metadata lives in the
// `chat_attachments` table (FK-cascaded to messages + conversations).
// `parts` JSON carries only `{ type:'file', attachmentId }`; the route layer
// hydrates that into `{ url, mediaType, name, size }` on read.

import fs from 'fs';
import path from 'path';
import { createHash, randomBytes } from 'crypto';
import { paths } from '../../config/paths.js';
import { logger } from '../../lib/logger.js';
import {
  appendAttachment, listAttachmentsForMessage, listAttachmentsForConversation,
  listAllAttachments, type AttachmentRow, type AttachmentSource,
} from '../../lib/db/chat.repo.js';

const ATTACH_SUBDIR = 'chat-attachments';
const ATTACH_URL_PREFIX = '/api/chat/attachments/';

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
  'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp',
  'image/tiff': 'tiff', 'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg',
  'video/mp4': 'mp4', 'video/webm': 'webm',
};

export function attachmentDir(): string {
  return path.join(paths.runtimeStateDir, ATTACH_SUBDIR);
}

function ensureDir(): void {
  fs.mkdirSync(attachmentDir(), { recursive: true, mode: 0o700 });
}

/** 16-char base64url id, ~96 bits of entropy. */
export function makeAttachmentId(): string {
  return randomBytes(12).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function extFromMime(mime: string): string {
  return MIME_TO_EXT[mime.toLowerCase().split(';')[0].trim()] ?? 'bin';
}

function parseDataUrl(url: string): { buf: Buffer; mime: string } | null {
  if (!url.startsWith('data:')) return null;
  const comma = url.indexOf(',');
  if (comma < 0) return null;
  const [mime, encoding] = url.slice(5, comma).split(';');
  if (encoding !== 'base64') return null;
  try { return { buf: Buffer.from(url.slice(comma + 1), 'base64'), mime: mime ?? '' }; }
  catch { return null; }
}

type Part = Record<string, unknown>;

export interface ExtractResult {
  rewrittenParts: Part[];
  attachmentIds: string[];
}

/** Persist a single buffer as a file + chat_attachments row. */
export function persistAttachmentBytes(
  buf: Buffer,
  opts: {
    conversationId: string;
    messageId: string;
    mimeType: string;
    displayName?: string | null;
    source: AttachmentSource;
  },
): { id: string; ext: string; url: string; size: number } {
  const id = makeAttachmentId();
  const ext = extFromMime(opts.mimeType);
  const filename = `${id}.${ext}`;
  ensureDir();
  fs.writeFileSync(path.join(attachmentDir(), filename), buf, { mode: 0o600 });
  appendAttachment({
    id,
    conversation_id: opts.conversationId,
    message_id: opts.messageId,
    display_name: opts.displayName ?? null,
    mime_type: opts.mimeType,
    ext,
    size_bytes: buf.byteLength,
    content_hash: createHash('sha256').update(buf).digest('hex'),
    source: opts.source,
    created_at: Date.now(),
  });
  return { id, ext, url: `${ATTACH_URL_PREFIX}${filename}`, size: buf.byteLength };
}

/** Walk parts; for each `{ type:'file', url:'data:...' }` entry, persist
 *  bytes + insert a row, replacing the part with `{ type:'file', attachmentId }`. */
export function extractAndPersistAttachments(
  conversationId: string,
  messageId: string,
  parts: Part[],
): ExtractResult {
  const attachmentIds: string[] = [];
  const rewrittenParts: Part[] = parts.map((part) => {
    if (!part || typeof part !== 'object' || (part as { type?: unknown }).type !== 'file') return part;
    const url = typeof part.url === 'string' ? part.url : '';
    if (!url.startsWith('data:')) return part;
    const parsed = parseDataUrl(url);
    if (!parsed) return part;

    const mime = parsed.mime
      || (typeof part.mediaType === 'string' ? part.mediaType : '')
      || 'application/octet-stream';
    const displayName = typeof part.name === 'string' ? part.name : null;

    try {
      const { id } = persistAttachmentBytes(parsed.buf, {
        conversationId, messageId, mimeType: mime, displayName, source: 'user',
      });
      attachmentIds.push(id);
      const rewritten: Part = { type: 'file', attachmentId: id };
      if (displayName) rewritten.name = displayName;
      return rewritten;
    } catch (err) {
      logger.warn('chat attachments: failed to persist file', { messageId, error: String(err) });
      return part;
    }
  });
  return { rewrittenParts, attachmentIds };
}

/* hydration (read path) ────────────────────────────────────────── */

export interface HydratedFilePart {
  type: 'file';
  url: string;
  mediaType: string;
  name?: string;
  size?: number;
}

/** Replace `{ type:'file', attachmentId }` parts with `{ url, mediaType, name,
 *  size }`. Missing rows yield a stub so a stale ref still renders. */
export function hydrateParts(
  parts: unknown,
  attachmentsById: Map<string, AttachmentRow>,
): unknown {
  if (!Array.isArray(parts)) return parts;
  return parts.map((part) => {
    if (!part || typeof part !== 'object' || (part as { type?: unknown }).type !== 'file') return part;
    const aid = (part as { attachmentId?: unknown }).attachmentId;
    if (typeof aid !== 'string') return part;
    const row = attachmentsById.get(aid);
    if (!row) return { type: 'file', name: 'missing', mediaType: 'application/octet-stream' };
    const hydrated: HydratedFilePart = {
      type: 'file',
      url: `${ATTACH_URL_PREFIX}${row.id}.${row.ext}`,
      mediaType: row.mime_type,
      size: row.size_bytes,
    };
    if (row.display_name) hydrated.name = row.display_name;
    return hydrated;
  });
}

export function buildAttachmentMap(rows: AttachmentRow[]): Map<string, AttachmentRow> {
  const m = new Map<string, AttachmentRow>();
  for (const r of rows) m.set(r.id, r);
  return m;
}

/* delete-time file unlink ──────────────────────────────────────── */

function unlinkAttachmentFile(row: AttachmentRow): void {
  const filename = `${row.id}.${row.ext}`;
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) return;
  try { fs.unlinkSync(path.join(attachmentDir(), filename)); }
  catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.warn('chat attachments: unlink failed', { id: row.id, error: String(err) });
    }
  }
}

/** Unlink files for one message. DB rows go via FK cascade — call this
 *  BEFORE deleting the parent row. */
export function deleteMessageAttachmentFiles(messageId: string): void {
  for (const row of listAttachmentsForMessage(messageId)) unlinkAttachmentFile(row);
}

export function deleteConversationAttachmentFiles(conversationId: string): void {
  for (const row of listAttachmentsForConversation(conversationId)) unlinkAttachmentFile(row);
}

export function deleteAllAttachmentFiles(): void {
  for (const row of listAllAttachments()) unlinkAttachmentFile(row);
}
