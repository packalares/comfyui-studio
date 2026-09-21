// Smart-switch fast path: when the target model is vision-capable and an
// attached PDF is SCANNED (no text layer) and small, render its pages to images
// and attach them directly to the request — so the vision model reads the pages
// in ONE pass, instead of Docling OCR'ing every page to text and the model then
// answering from that text (N+1 calls → 1). Text PDFs, long scanned PDFs, and
// text-only models fall through untouched to the normal Docling path.
//
// Runs BEFORE processLlmAttachments; any PDF it inlines is removed from the
// request so Docling never sees it. Never throws to the caller in a way that
// blocks the request — on any failure we simply leave the PDF for Docling.

import { request as undiciRequest } from 'undici';
import { getDoclingUrl, getOllamaUrl } from '../settings/index.js';
import { logger } from '../../lib/logger.js';

// Max pages to inline as images. Above this, a scanned PDF stays on the Docling
// path (compact text) rather than blowing the vision context with many images.
const DEFAULT_MAX_VISION_PAGES = 10;

type AnyRecord = Record<string, unknown>;

// model → has-vision, cached (capabilities don't change under us at runtime).
const visionCache = new Map<string, boolean>();

/** Does this model accept images? Reads Ollama /api/show capabilities. */
export async function modelHasVision(model: string): Promise<boolean> {
  if (!model) return false;
  const cached = visionCache.get(model);
  if (cached !== undefined) return cached;
  let has = false;
  try {
    const r = await undiciRequest(`${getOllamaUrl()}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    });
    if (r.statusCode >= 200 && r.statusCode < 300) {
      const j = (await r.body.json()) as { capabilities?: unknown };
      has = Array.isArray(j.capabilities) && j.capabilities.includes('vision');
    } else {
      await r.body.dump();
    }
  } catch (e) {
    logger.warn('modelHasVision check failed', { model, error: String(e) });
  }
  visionCache.set(model, has);
  return has;
}

function stripDataUri(s: string): string {
  const m = /^data:[^;,]*;base64,(.*)$/s.exec(s);
  return m ? m[1] : s;
}
function extOf(filename: string): string {
  const i = filename.lastIndexOf('.');
  return i >= 0 ? filename.slice(i + 1).toLowerCase() : '';
}

export interface RenderResult { scanned: boolean; page_count: number; images: string[] }

/** Ask the docling wrapper to render a scanned PDF to page images. Returns null
 *  on any failure (caller then leaves the PDF for Docling). Exported so the chat
 *  path (documentContext) can reuse the same Flow-A rendering. */
export async function renderPdf(base64: string, filename: string, maxPages: number): Promise<RenderResult | null> {
  const base = getDoclingUrl();
  if (!base) return null;
  try {
    const r = await undiciRequest(`${base}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64_string: base64, filename, max_pages: maxPages }),
      headersTimeout: 60_000,
      bodyTimeout: 60_000,
    });
    if (r.statusCode < 200 || r.statusCode >= 300) { await r.body.dump(); return null; }
    return (await r.body.json()) as RenderResult;
  } catch (e) {
    logger.warn('renderPdf failed', { filename, error: String(e) });
    return null;
  }
}

/** Append page images to the latest user message, in the request's wire format. */
function attachImages(body: AnyRecord, mode: 'ollama' | 'openai', images: string[]): void {
  const msgs = Array.isArray(body.messages) ? (body.messages as AnyRecord[]) : null;
  if (!msgs) return;
  let target: AnyRecord | undefined;
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    if (msgs[i]?.role === 'user') { target = msgs[i]; break; }
  }
  if (!target) { target = { role: 'user', content: mode === 'openai' ? [] : '' }; msgs.push(target); }

  if (mode === 'openai') {
    let content = target.content;
    if (typeof content === 'string') content = content ? [{ type: 'text', text: content }] : [];
    if (!Array.isArray(content)) content = [];
    for (const b64 of images) {
      (content as AnyRecord[]).push({ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } });
    }
    target.content = content;
  } else {
    const arr = Array.isArray(target.images) ? (target.images as string[]) : [];
    for (const b64 of images) arr.push(b64);
    target.images = arr;
  }
}

/**
 * Inline scanned-PDF pages as images for vision models, IN PLACE. Removes any
 * inlined PDF from the request so Docling skips it. Returns how many PDFs were
 * inlined. No-op (returns {inlined:0}) when docling is unset, the model is
 * text-only, or there are no eligible scanned PDFs.
 */
export async function maybeInlinePdfImages(
  body: unknown,
  mode: 'ollama' | 'openai',
): Promise<{ inlined: number }> {
  if (!body || typeof body !== 'object') return { inlined: 0 };
  const b = body as AnyRecord;
  if (!getDoclingUrl()) return { inlined: 0 };
  const model = typeof b.model === 'string' ? b.model : '';
  if (!(await modelHasVision(model))) return { inlined: 0 };
  const maxPages = DEFAULT_MAX_VISION_PAGES;

  const images: string[] = [];
  let inlined = 0;

  // 1) custom top-level `attachments` field
  if (Array.isArray(b.attachments)) {
    const kept: unknown[] = [];
    for (const a of b.attachments as AnyRecord[]) {
      const o = (a || {}) as AnyRecord;
      const data = (typeof o.data === 'string' && o.data) || (typeof o.base64 === 'string' && o.base64) || '';
      const filename = (typeof o.filename === 'string' && o.filename)
        || (typeof o.name === 'string' && o.name) || 'document';
      if (data && extOf(filename) === 'pdf') {
        const res = await renderPdf(stripDataUri(data), filename, maxPages);
        if (res && res.images.length > 0) { images.push(...res.images); inlined += 1; continue; }
      }
      kept.push(a);
    }
    if (kept.length !== (b.attachments as unknown[]).length) b.attachments = kept;
  }

  // 2) OpenAI `file`/`input_file` content parts
  if (Array.isArray(b.messages)) {
    for (const msg of b.messages as AnyRecord[]) {
      if (!msg || !Array.isArray(msg.content)) continue;
      const kept: unknown[] = [];
      for (const part of msg.content as AnyRecord[]) {
        const p = (part || {}) as AnyRecord;
        const file = p.file as AnyRecord | undefined;
        const isFile = p.type === 'file' || p.type === 'input_file' || (file && file.file_data) || p.file_data;
        const filename = (file && typeof file.filename === 'string' && file.filename)
          || (typeof p.filename === 'string' && p.filename) || 'document';
        if (isFile && extOf(String(filename)) === 'pdf') {
          const data = (file && typeof file.file_data === 'string' && file.file_data)
            || (typeof p.file_data === 'string' && p.file_data) || '';
          if (data) {
            const res = await renderPdf(stripDataUri(data), String(filename), maxPages);
            if (res && res.images.length > 0) { images.push(...res.images); inlined += 1; continue; }
          }
        }
        kept.push(part);
      }
      if (kept.length !== (msg.content as unknown[]).length) msg.content = kept;
    }
  }

  if (images.length > 0) {
    attachImages(b, mode, images);
    logger.info('pdfVision: inlined scanned-PDF pages as images', { inlined, images: images.length, model });
  }
  return { inlined };
}
