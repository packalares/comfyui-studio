// In-chat document ingestion. The chat composer already inlines plain-text
// files client-side and maps images to Ollama `images`; this handles the
// binary document formats (PDF, DOCX, PPTX, XLSX) that need server-side
// extraction. For the latest user message we run each document attachment
// through Docling and inject the extracted markdown as a text part — into the
// in-memory message Ollama sees this turn AND the persisted row so follow-up
// turns keep the context. Failures are injected as a short note rather than
// aborting the stream.

import type { UIMessage } from 'ai';
import * as repo from '../../lib/db/chat.repo.js';
import { getDoclingUrl } from '../settings/index.js';
import { extractDocument, DoclingError } from '../docling/client.js';
import { modelHasVision, renderPdf } from '../llm/pdfVision.js';
import { logger } from '../../lib/logger.js';

interface Part { type?: string; text?: string; url?: string; mediaType?: string; name?: string }

const MAX_VISION_PAGES = 10;

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

/** A `file` data-URL part that is neither image nor a/v — i.e. a document. */
function isDocumentPart(p: Part): boolean {
  if (p.type !== 'file' || typeof p.url !== 'string' || !p.url.startsWith('data:')) return false;
  const mt = (p.mediaType ?? '').toLowerCase();
  return !(mt.startsWith('image/') || mt.startsWith('audio/') || mt.startsWith('video/'));
}

function base64FromDataUrl(url: string): string | null {
  const comma = url.indexOf(',');
  if (comma < 0) return null;
  if (!url.slice(5, comma).includes('base64')) return null;
  return url.slice(comma + 1);
}

/**
 * Extract text from document attachments on the latest user message and inject
 * it (in place) + persist it. No-op when there are no document parts.
 */
export async function augmentWithDocumentText(
  messages: UIMessage[],
  userMsgId: string | null,
  model?: string,
): Promise<void> {
  let target: UIMessage | undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') { target = messages[i]; break; }
  }
  if (!target) return;

  const parts = (target.parts ?? []) as Part[];
  const docs = parts.filter(isDocumentPart);
  if (docs.length === 0) return;

  const configured = !!getDoclingUrl();
  // Flow A (fast path): a vision-capable model can read scanned-PDF pages as
  // images directly (1 call), skipping per-page OCR-to-text. Only probed for
  // vision models; text PDFs and text-only models stay on the Docling text path.
  const vision = configured && !!model && (await modelHasVision(model));
  const blocks: string[] = [];       // text (Flow B) or short notes (Flow A)
  const mediaParts: Part[] = [];     // rendered page images (Flow A)

  for (const d of docs) {
    const name = typeof d.name === 'string' && d.name ? d.name : 'document';
    if (!configured) {
      blocks.push(`[${name}] (not read — document parsing is not configured in Settings → Tools)`);
      continue;
    }
    const b64 = base64FromDataUrl(d.url as string);
    if (!b64) { blocks.push(`[${name}] (could not decode)`); continue; }

    // Flow A: scanned PDF + vision model → send page images.
    if (vision && extOf(name) === 'pdf') {
      const res = await renderPdf(b64, name, MAX_VISION_PAGES);
      if (res && res.scanned && res.images.length > 0) {
        res.images.forEach((img, i) => mediaParts.push({
          type: 'file', url: `data:image/png;base64,${img}`,
          mediaType: 'image/png', name: `${name} p${i + 1}`,
        }));
        blocks.push(`[${name}] (${res.images.length} page image(s) sent to the vision model)`);
        logger.info('chat Flow A: inlined scanned-PDF pages as images', {
          name, pages: res.images.length, model });
        continue;
      }
    }

    // Flow B: extract text via Docling.
    try {
      const text = await extractDocument(b64, name);
      blocks.push(`[${name}]\n${text}`);
    } catch (err) {
      const msg = err instanceof DoclingError || err instanceof Error ? err.message : String(err);
      blocks.push(`[${name}] (failed to read: ${msg})`);
      logger.warn('chat document extract failed', { name, error: msg });
    }
  }

  const block = `=== Attached documents ===\n${blocks.join('\n\n')}\n=== End of attached documents ===`;
  const textPart: Part = { type: 'text', text: block };

  // Inject for the current turn: the note/text first (reads before the question),
  // then any rendered page images, then the original parts.
  (target as { parts?: Part[] }).parts = [textPart, ...mediaParts, ...parts];

  // Persist so refetch + follow-up turns keep the extracted context.
  if (userMsgId) {
    try {
      const row = repo.getMessage(userMsgId);
      const raw = (row as { parts?: unknown } | null)?.parts;
      const persisted = typeof raw === 'string' ? JSON.parse(raw || '[]') : Array.isArray(raw) ? raw : [];
      if (Array.isArray(persisted)) {
        persisted.push(textPart);
        repo.updateMessageParts(userMsgId, JSON.stringify(persisted));
      }
    } catch (err) {
      logger.warn('chat document persist failed', { userMsgId, error: String(err) });
    }
  }
}
