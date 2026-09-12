// LLM-API file ingestion. Turns document attachments on an /api/llm or /v1
// request into extracted text (via Docling) that gets injected into the
// prompt/messages, then enforces the input-token budget and (for native
// requests) raises num_ctx so the model actually sees the whole document.
//
// Attachments arrive one of two ways:
//   1. a custom top-level `attachments: [{ filename, data|base64, mime? }]`
//      (used by the Studio chat composer and easy to document for API clients);
//   2. OpenAI-style content parts of type `file`/`input_file` inside
//      `messages[].content` (so third-party OpenAI SDKs that emit them work).
//
// All rejections throw AttachmentError(code, httpStatus, message); the route
// maps that to an Ollama- or OpenAI-shaped error body.

import { extractDocument, DoclingError } from '../docling/client.js';
import {
  getDoclingUrl, getDoclingFileTypes, getDoclingMaxUploadMb, getLlmMaxInputTokens,
} from '../settings/index.js';
import { logger } from '../../lib/logger.js';

export class AttachmentError extends Error {
  constructor(public code: string, public status: number, message: string) {
    super(message);
    this.name = 'AttachmentError';
  }
}

interface RawAttachment { filename: string; base64: string; }

// Rough token estimate (~4 chars/token). Good enough for budget gating; we err
// on the safe side by rejecting before the model would truncate silently.
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function stripDataUri(s: string): string {
  const m = /^data:[^;,]*;base64,(.*)$/s.exec(s);
  return m ? m[1] : s;
}

function extOf(filename: string): string {
  const i = filename.lastIndexOf('.');
  return i >= 0 ? filename.slice(i + 1).toLowerCase() : '';
}

// Images are the docscanner's job (vision), never Docling's — skip them here.
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff', 'tif', 'heic', 'heif']);
function isImageName(filename: string): boolean {
  return IMAGE_EXTS.has(extOf(filename));
}

// base64 length → decoded byte count. Padding is at most 2 '=' chars, so we
// subtract them directly instead of a `/=+$/` regex (which CodeQL flags as a
// polynomial-ReDoS on large inputs).
function base64Bytes(b64: string): number {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

type AnyRecord = Record<string, unknown>;
interface ContentPart { type?: string; text?: string; file?: { filename?: string; file_data?: string }; file_data?: string; filename?: string }

/** Pull attachments from the custom `attachments` field. */
function fromCustomField(body: AnyRecord): RawAttachment[] {
  const raw = body.attachments;
  if (!Array.isArray(raw)) return [];
  const out: RawAttachment[] = [];
  for (const a of raw) {
    if (!a || typeof a !== 'object') continue;
    const o = a as AnyRecord;
    const data = (typeof o.data === 'string' && o.data)
      || (typeof o.base64 === 'string' && o.base64)
      || '';
    const filename = typeof o.filename === 'string' && o.filename ? o.filename
      : typeof o.name === 'string' && o.name ? o.name : 'document';
    if (data && !isImageName(filename)) out.push({ filename, base64: stripDataUri(data) });
  }
  return out;
}

/** Pull attachments from OpenAI `file`/`input_file` content parts, and strip
 *  those parts out of the messages so they aren't forwarded upstream. */
function fromOpenAiParts(body: AnyRecord): RawAttachment[] {
  const messages = body.messages;
  if (!Array.isArray(messages)) return [];
  const out: RawAttachment[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const m = msg as AnyRecord;
    if (!Array.isArray(m.content)) continue;
    const kept: ContentPart[] = [];
    for (const part of m.content as ContentPart[]) {
      const isFile = part && (part.type === 'file' || part.type === 'input_file' || part.file?.file_data || part.file_data);
      const filename = part?.file?.filename || part?.filename || 'document';
      // Extract only non-image document files; leave images (and everything
      // else, incl. image_url parts) in the message for docscanner / the model.
      if (isFile && !isImageName(filename)) {
        const data = part.file?.file_data || part.file_data || '';
        if (data) out.push({ filename, base64: stripDataUri(data) });
      } else {
        kept.push(part);
      }
    }
    if (kept.length !== (m.content as ContentPart[]).length) m.content = kept;
  }
  return out;
}

/** Concatenated text of all messages + prompt, for token estimation. */
function collectText(body: AnyRecord): string {
  let text = typeof body.prompt === 'string' ? body.prompt : '';
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      const m = msg as AnyRecord;
      if (typeof m.content === 'string') text += '\n' + m.content;
      else if (Array.isArray(m.content)) {
        for (const p of m.content as ContentPart[]) if (typeof p.text === 'string') text += '\n' + p.text;
      }
    }
  }
  return text;
}

/** Prepend a document block to the request (last user message, or the prompt). */
function inject(body: AnyRecord, block: string): void {
  if (Array.isArray(body.messages)) {
    const msgs = body.messages as AnyRecord[];
    let target: AnyRecord | undefined;
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      if (msgs[i]?.role === 'user') { target = msgs[i]; break; }
    }
    if (!target) { msgs.push({ role: 'user', content: block }); return; }
    if (typeof target.content === 'string') target.content = block + target.content;
    else if (Array.isArray(target.content)) (target.content as ContentPart[]).unshift({ type: 'text', text: block });
    else target.content = block;
    return;
  }
  if (typeof body.prompt === 'string') body.prompt = block + body.prompt;
  else body.prompt = block;
}

export interface AttachmentOutcome {
  changed: boolean;
  count: number;
  injectedChars: number;
}

/**
 * Process attachments on a request body IN PLACE. Returns what happened.
 * Throws AttachmentError on any rejection (docling off, too large, bad type,
 * extraction failure, or context-budget exceeded).
 */
export async function processLlmAttachments(
  body: unknown,
  mode: 'ollama' | 'openai',
): Promise<AttachmentOutcome> {
  if (!body || typeof body !== 'object') return { changed: false, count: 0, injectedChars: 0 };
  const b = body as AnyRecord;

  const attachments = [...fromCustomField(b), ...fromOpenAiParts(b)];
  if (attachments.length === 0) return { changed: false, count: 0, injectedChars: 0 };

  // Attachments present → ingestion must be configured.
  if (!getDoclingUrl()) {
    throw new AttachmentError('docling_not_configured', 501,
      'File attachments are not supported: Docling is not configured on this server.');
  }
  // Drop the custom field so it isn't forwarded upstream.
  delete b.attachments;

  const allowed = new Set(getDoclingFileTypes());
  const maxBytes = getDoclingMaxUploadMb() * 1024 * 1024;

  const blocks: string[] = [];
  for (const att of attachments) {
    const ext = extOf(att.filename);
    if (!ext || !allowed.has(ext)) {
      throw new AttachmentError('unsupported_file_type', 415,
        `Unsupported file type "${ext || att.filename}". Allowed: ${[...allowed].join(', ')}.`);
    }
    if (base64Bytes(att.base64) > maxBytes) {
      throw new AttachmentError('file_too_large', 413,
        `File "${att.filename}" exceeds the ${getDoclingMaxUploadMb()} MB limit.`);
    }
    let text: string;
    try {
      text = await extractDocument(att.base64, att.filename);
    } catch (err) {
      if (err instanceof DoclingError) {
        throw new AttachmentError(err.code, 502, `Failed to parse "${att.filename}": ${err.message}`);
      }
      throw err;
    }
    blocks.push(`[${att.filename}]\n${text}`);
  }

  const block =
    '=== Attached documents ===\n' +
    blocks.join('\n\n') +
    '\n=== End of attached documents ===\n\n';
  inject(b, block);

  // Budget check on the whole (now-injected) input.
  const maxInput = getLlmMaxInputTokens();
  const inputTokens = approxTokens(collectText(b));
  if (inputTokens > maxInput) {
    throw new AttachmentError('context_exceeded', 422,
      `Attached document(s) + prompt (~${inputTokens} tokens) exceed the ${maxInput}-token input limit. ` +
      'Use a smaller document or raise the limit in Settings.');
  }

  // Native Ollama: raise num_ctx so the model actually reads the whole input.
  // (The OpenAI-compat endpoint does not accept num_ctx per request; there the
  // server's context length governs, but the budget check above still applies.)
  if (mode === 'ollama') {
    const opts = (b.options && typeof b.options === 'object') ? b.options as AnyRecord : {};
    const reserveRaw = Number(opts.num_predict ?? b.max_tokens ?? 1024);
    const reserve = Number.isFinite(reserveRaw) ? Math.min(4096, Math.max(256, reserveRaw)) : 1024;
    opts.num_ctx = Math.min(maxInput, inputTokens + reserve);
    b.options = opts;
  }

  const injectedChars = block.length;
  logger.info('llm attachments injected', { count: attachments.length, injectedChars, inputTokens, mode });
  return { changed: true, count: attachments.length, injectedChars };
}
