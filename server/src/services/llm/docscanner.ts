// docscanner image preprocessing for the LLM API.
//
// When a request carries `docscanner: true | {config}` (and a DocScanner URL is
// configured in settings), every vision image in the request is run through the
// docscanner service (dewarp + cleanup) and REPLACED in place — the model then
// sees the scanned page instead of the raw photo. `{scan_only:true}` returns the
// scanned image directly without calling the model.
//
// Only images are handled here; document files stay on the Docling path.

import { scanImage, DocscannerError } from '../docscanner/client.js';
import { logger } from '../../lib/logger.js';

// Per-request config we accept and forward to /scan/json. Anything else in the
// request object is dropped; missing keys fall back to the service defaults.
const ALLOWED = new Set(['mode', 'dewarp', 'sharpen', 'white_point', 'format']);
const MODES = new Set(['clean', 'natural', 'grayscale', 'binary']);

export interface DocscannerRequest {
  enabled: boolean;
  scanOnly: boolean;
  config: Record<string, unknown>;
}

/** Parse + validate the `docscanner` request field. */
export function parseDocscannerField(body: unknown): DocscannerRequest {
  const raw = (body as { docscanner?: unknown } | null)?.docscanner;
  if (raw === true) return { enabled: true, scanOnly: false, config: {} };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    const config: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      if (k === 'scan_only' || !ALLOWED.has(k)) continue; // drop unknown keys
      if (k === 'mode') { if (MODES.has(String(v))) config.mode = String(v); }
      else if (k === 'format') { config.format = String(v).toLowerCase() === 'jpg' ? 'jpg' : 'png'; }
      else if (k === 'dewarp') { if (typeof v === 'boolean') config.dewarp = v; }
      else if (k === 'sharpen') { if (typeof v === 'number' && Number.isFinite(v)) config.sharpen = Math.max(0, Math.min(5, v)); }
      else if (k === 'white_point') { if (typeof v === 'number' && Number.isFinite(v)) config.white_point = Math.max(120, Math.min(255, v)); }
    }
    return { enabled: true, scanOnly: o.scan_only === true, config };
  }
  return { enabled: false, scanOnly: false, config: {} };
}

function stripDataUri(s: string): string {
  const comma = s.indexOf(',');
  return s.startsWith('data:') && comma >= 0 ? s.slice(comma + 1) : s;
}

interface Part { type?: string; image_url?: { url?: string } }

/**
 * Scan every vision image in the request IN PLACE and return how many were
 * replaced plus the first scanned result (for scan_only). Handles Ollama-native
 * `messages[].images` (base64) and OpenAI `image_url` data-URI content parts.
 */
export async function scanRequestImages(
  body: unknown,
  config: Record<string, unknown>,
): Promise<{ count: number; first?: { image_b64: string; format: string } }> {
  const b = body as { messages?: unknown };
  let count = 0;
  let first: { image_b64: string; format: string } | undefined;
  if (!Array.isArray(b.messages)) return { count, first };

  for (const msg of b.messages) {
    const m = msg as { images?: unknown; content?: unknown };
    // Ollama native: messages[].images = [base64, ...]
    if (Array.isArray(m.images)) {
      for (let i = 0; i < m.images.length; i += 1) {
        const res = await scanImage(stripDataUri(String(m.images[i])), config);
        m.images[i] = res.image_b64;
        count += 1; first = first ?? res;
      }
    }
    // OpenAI: messages[].content[].image_url.url (data: URI)
    if (Array.isArray(m.content)) {
      for (const part of m.content as Part[]) {
        const url = part?.type === 'image_url' ? part.image_url?.url : undefined;
        if (typeof url === 'string' && url.startsWith('data:')) {
          const res = await scanImage(stripDataUri(url), config);
          part.image_url!.url = `data:image/${res.format};base64,${res.image_b64}`;
          count += 1; first = first ?? res;
        }
      }
    }
  }
  if (count > 0) logger.info('docscanner replaced request images', { count });
  return { count, first };
}

export { DocscannerError };
