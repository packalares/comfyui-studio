// In-chat image scanning (docscanner: UVDoc dewarp + OpenCV cleanup).
//
// Mirrors documentContext.ts — runs on the in-memory `messages` just before
// convertToOllamaMessages, operating on the LATEST user message's image
// attachments. The composer's Scan control picks the mode:
//
//   'off'  → no-op (a normal photo goes to the vision model raw).
//   'ai'   → clean each image and REPLACE the data-URL the model reads, so
//            the vision model sees the dewarped/cleaned scan. Non-fatal: a
//            scan failure falls back to the raw image.
//   'only' → clean each image and hand it straight back as the assistant
//            reply — no LLM turn (see streamChat's scan-only short-circuit).
//            A scan failure is surfaced to the caller.
//
// Gated on the DocScanner URL being configured (Settings → Tools). When unset,
// this is a no-op regardless of mode.

import type { UIMessage } from 'ai';
import { logger } from '../../lib/logger.js';
import { getDocscannerUrl } from '../settings/index.js';
import { scanImage } from '../docscanner/client.js';
import { extractBase64FromDataUrl } from './ollama.js';

export type ScanMode = 'off' | 'ai' | 'only';

interface ImagePartRef {
  part: Record<string, unknown>;
  base64: string;
}

/** Image file-parts (carrying a data: URL) on the latest user message. */
function latestUserImageParts(messages: UIMessage[]): ImagePartRef[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i] as unknown as { role?: string; parts?: unknown };
    if (m?.role !== 'user') continue;
    const parts = Array.isArray(m.parts) ? (m.parts as Record<string, unknown>[]) : [];
    const out: ImagePartRef[] = [];
    for (const p of parts) {
      if (p.type === 'file' && typeof p.url === 'string'
          && typeof p.mediaType === 'string' && p.mediaType.startsWith('image/')) {
        const b64 = extractBase64FromDataUrl(p.url);
        if (b64) out.push({ part: p, base64: b64 });
      }
    }
    return out; // only the latest user turn carries live images
  }
  return [];
}

function mediaTypeFor(format: string): string {
  return format === 'jpg' || format === 'jpeg' ? 'image/jpeg' : `image/${format}`;
}

export interface ScannedImage { base64: string; format: string; mediaType: string }

export interface ImageScanOutcome {
  /** How many images were successfully cleaned. */
  scanned: number;
  /** The cleaned images (used by 'only' mode to build the reply). */
  images: ScannedImage[];
}

/**
 * Scan the latest user message's image attachments IN PLACE.
 *
 * In 'ai' mode the cleaned data-URI overwrites `part.url`/`part.mediaType`, so
 * convertToOllamaMessages hands the vision model the cleaned image. In 'only'
 * mode the parts are left untouched (the user still sees their upload) and the
 * cleaned images are returned for the caller to post as the reply.
 *
 * @throws DocscannerError in 'only' mode when a scan fails; 'ai' swallows.
 */
export async function scanChatImages(
  messages: UIMessage[],
  mode: ScanMode,
): Promise<ImageScanOutcome> {
  if (mode === 'off' || !getDocscannerUrl()) return { scanned: 0, images: [] };
  const refs = latestUserImageParts(messages);
  if (refs.length === 0) return { scanned: 0, images: [] };

  const images: ScannedImage[] = [];
  for (const ref of refs) {
    let result;
    try {
      result = await scanImage(ref.base64);
    } catch (err) {
      if (mode === 'only') throw err;          // caller surfaces the failure
      logger.warn('chat image scan failed; using raw image', {
        error: err instanceof Error ? err.message : String(err),
      });
      continue;                                 // 'ai': fall back to the raw image
    }
    const mediaType = mediaTypeFor(result.format);
    images.push({ base64: result.image_b64, format: result.format, mediaType });
    if (mode === 'ai') {
      ref.part.url = `data:${mediaType};base64,${result.image_b64}`;
      ref.part.mediaType = mediaType;
    }
  }
  logger.info('chat images scanned', { scanned: images.length, mode });
  return { scanned: images.length, images };
}
