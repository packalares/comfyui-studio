// Persist inline binary content from MCP tool results to Studio's
// chat-attachments dir, then rewrite the result so the model sees a small
// URL string instead of a multi-megabyte base64 blob.
//
// Without this, an MCP tool that returns a screenshot or PDF as inline
// bytes (`{ type: "image", data: <huge base64>, mimeType: "image/png" }`)
// produces a tool message the LLM treats as opaque text — and many models
// will dutifully echo it back into chat token-by-token, blocking the
// stream for minutes. Here we intercept BEFORE the result is shown to
// the model: save the bytes once, swap the entry for a tiny text reference
// pointing at `/api/chat/attachments/<filename>`. The chat UI's renderer
// detects the URL and inlines an `<img>` / download link.

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { attachmentDir, extFromMime } from './attachments.js';
import { logger } from '../../lib/logger.js';

const ATTACH_URL_PREFIX = '/api/chat/attachments/';

/** Optional context the wrapper passes through so saved files are namespaced
 *  per tool call (helps debugging and the 7-day attachment sweep). */
export interface ToolMediaContext {
  conversationId?: string;
  toolCallId?: string;
}

interface McpResult {
  content?: unknown;
  [k: string]: unknown;
}

interface InlineImage { type: 'image'; data: string; mimeType: string }
interface InlineResource {
  type: 'resource';
  resource?: { blob?: string; mimeType?: string; uri?: string };
  blob?: string;
  mimeType?: string;
}

function isInlineImage(item: unknown): item is InlineImage {
  if (!item || typeof item !== 'object') return false;
  const o = item as Record<string, unknown>;
  return o.type === 'image'
    && typeof o.data === 'string' && o.data.length > 0
    && typeof o.mimeType === 'string' && o.mimeType.length > 0;
}

/** MCP allows resource content as either inline (legacy `blob` on top-level)
 *  or nested under `resource.blob`. Accept both shapes. */
function readResourceBlob(item: unknown): { blob: string; mimeType: string } | null {
  if (!item || typeof item !== 'object') return null;
  const o = item as InlineResource;
  if (o.type !== 'resource') return null;
  const res = o.resource;
  const blob = (res?.blob ?? o.blob);
  const mimeType = (res?.mimeType ?? o.mimeType);
  if (typeof blob !== 'string' || blob.length === 0) return null;
  if (typeof mimeType !== 'string' || mimeType.length === 0) return null;
  return { blob, mimeType };
}

/** Many MCP servers (notably crawl4ai) wrap a REST API response as a single
 *  `{ type: "text", text: "<json string>" }` content entry instead of using
 *  the canonical `image` / `resource` content shapes. The wrapped JSON
 *  carries the binary payload under a well-known field name. Detect that
 *  shape so we still get attachment-extraction.
 *
 *  Returns `null` if the text isn't JSON, isn't an object, or doesn't carry
 *  a recognised binary field.
 */
const KNOWN_BINARY_FIELDS: ReadonlyArray<{ key: string; mime: string }> = [
  { key: 'screenshot', mime: 'image/png' },
  { key: 'image', mime: 'image/png' },
  { key: 'pdf', mime: 'application/pdf' },
  { key: 'audio', mime: 'audio/mpeg' },
];
const BASE64_HEAD_RX = /^[A-Za-z0-9+/=\s]+$/;

function readEmbeddedBinaryFromTextJson(item: unknown):
  { base64: string; mimeType: string } | null {
  if (!item || typeof item !== 'object') return null;
  const o = item as Record<string, unknown>;
  if (o.type !== 'text' || typeof o.text !== 'string') return null;
  // Cheap rejection: must look like JSON.
  const trimmed = o.text.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const fields = parsed as Record<string, unknown>;
  for (const { key, mime } of KNOWN_BINARY_FIELDS) {
    const v = fields[key];
    if (typeof v !== 'string' || v.length < 100) continue;
    // First 100 chars must be pure base64 alphabet — guards against e.g.
    // `screenshot: "/path/to/file.png"` returning a path string.
    if (!BASE64_HEAD_RX.test(v.slice(0, 100))) continue;
    return { base64: v, mimeType: mime };
  }
  return null;
}

/** Decode base64 + write to attachment dir. Returns the filename. */
function persistBase64(b64: string, mimeType: string, ctx: ToolMediaContext): string {
  const buf = Buffer.from(b64, 'base64');
  const sha = createHash('sha256').update(buf).digest('hex').slice(0, 12);
  const ext = extFromMime(mimeType);
  // Studio's executeOllamaToolCall currently passes `toolCallId: ''` (empty
  // string), which the older `??` fallback didn't catch — leaving filenames
  // like `-80a262c24e2a.png` with a stray leading dash. Treat empty as
  // missing so the prefix collapses cleanly to `tool-<sha>.<ext>`.
  const prefix = ctx.toolCallId && ctx.toolCallId.length > 0 ? ctx.toolCallId : 'tool';
  const filename = `${prefix}-${sha}.${ext}`;
  const dir = attachmentDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, filename), buf, { mode: 0o600 });
  return filename;
}

function humanLabel(mimeType: string): string {
  if (mimeType.startsWith('image/')) return 'Image';
  if (mimeType === 'application/pdf') return 'PDF';
  if (mimeType.startsWith('audio/')) return 'Audio';
  if (mimeType.startsWith('video/')) return 'Video';
  return 'File';
}

/** Tool result message the LLM sees after we persist a piece of binary
 *  content. Worded as a *terminal* event so the model stops retrying — it
 *  has the file, the user sees it inline, the job is done. */
function persistedMessage(mimeType: string, filename: string): string {
  const label = humanLabel(mimeType);
  return `${label} saved and rendered to the user → ${ATTACH_URL_PREFIX}${filename}. `
    + `This call succeeded; do NOT call the tool again for the same URL.`;
}

/**
 * Walk an MCP tool result's `content` array; for every inline binary entry,
 * save the bytes and replace the entry with a short text pointer. Returns
 * the original result when nothing matches so callers can pass any value
 * through without checks.
 *
 * Errors during persistence are non-fatal — the original entry passes
 * through unchanged so the model still sees something coherent.
 */
export function persistInlineMediaInResult(
  result: unknown,
  ctx: ToolMediaContext = {},
): unknown {
  if (!result || typeof result !== 'object') return result;
  const obj = result as McpResult;
  const content = obj.content;
  if (!Array.isArray(content)) return result;

  let didRewrite = false;
  const rewritten: unknown[] = [];
  for (const item of content) {
    try {
      if (isInlineImage(item)) {
        const filename = persistBase64(item.data, item.mimeType, ctx);
        rewritten.push({
          type: 'text',
          text: persistedMessage(item.mimeType, filename),
        });
        didRewrite = true;
        continue;
      }
      const resource = readResourceBlob(item);
      if (resource) {
        const filename = persistBase64(resource.blob, resource.mimeType, ctx);
        rewritten.push({
          type: 'text',
          text: persistedMessage(resource.mimeType, filename),
        });
        didRewrite = true;
        continue;
      }
      const embedded = readEmbeddedBinaryFromTextJson(item);
      if (embedded) {
        const filename = persistBase64(embedded.base64, embedded.mimeType, ctx);
        rewritten.push({
          type: 'text',
          text: persistedMessage(embedded.mimeType, filename),
        });
        didRewrite = true;
        continue;
      }
    } catch (err) {
      logger.warn('toolMediaPersist: failed to persist content entry', {
        toolCallId: ctx.toolCallId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    rewritten.push(item);
  }

  if (!didRewrite) return result;
  return { ...obj, content: rewritten };
}
