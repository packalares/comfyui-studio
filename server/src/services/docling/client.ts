// Thin client for docling-serve (the local Docling document parser). Everything
// goes through the single POST /v1/convert endpoint (multi-format). Runs against
// the in-cluster Service — no data leaves the box. The URL comes from settings
// (Tools → Docling); when unset, callers should treat file ingestion as disabled.

import { request as undiciRequest } from 'undici';
import { getDoclingUrl } from '../settings/index.js';
import { logger } from '../../lib/logger.js';

export class DoclingError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'DoclingError';
  }
}

/**
 * Convert one document (base64) to markdown text — the chat / LLM-attachment
 * ingestion path. Thin wrapper over convertDocument(format='markdown'); kept as
 * its own function so callers stay on a simple (base64, filename) → string API.
 * @throws DoclingError with a stable `code` on any failure.
 */
export async function extractDocument(
  base64: string,
  filename: string,
  // 300s: scanned PDFs route through the VLM (per-page GPU inference via the
  // Studio queue), so multi-page docs can take minutes. The public nginx path
  // already allows 300s (proxy_read_timeout).
  timeoutMs = 300_000,
): Promise<string> {
  const r = await convertDocument(base64, filename, { format: 'markdown', timeoutMs });
  const text = typeof r.content === 'string' ? r.content : String(r.content ?? '');
  if (!text.trim()) {
    throw new DoclingError('docling_empty', `Docling returned no text for "${filename}"`);
  }
  return text;
}

// ---- the conversion endpoint --------------------------------------------------
// POST /v1/convert with a selectable output `format` and OCR `recognizer`.
// Everything (markdown-into-chat via extractDocument, plus structured
// json/csv/tables/layout) goes through here.

export type ConvertFormat =
  | 'markdown' | 'html' | 'text' | 'json' | 'csv';

export interface ConvertOptions {
  format: ConvertFormat;
  /** dots = end-to-end (default), paddle-vl = layout+element pipeline */
  recognizer?: 'dots' | 'paddle-vl';
  /** JSON schema to shape format=json extraction */
  schema?: unknown;
  /** per-request model options (e.g. num_predict) */
  options?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface ConvertResult {
  /** string for markdown/html/text/csv; object for json */
  content: unknown;
  format: string;
  recognizer?: string;
  pipeline?: string;
  ms?: number;
  warning?: string;
}

interface ConvertApiResponse {
  document?: { filename?: string; format?: string; content?: unknown };
  status?: string;
  _pipeline?: string;
  _recognizer?: string;
  _ms?: number;
  warning?: string;
  error?: string;
}

/**
 * Convert one document (base64) to the requested format via POST /v1/convert.
 * @throws DoclingError with a stable `code` on any failure.
 */
export async function convertDocument(
  base64: string,
  filename: string,
  opts: ConvertOptions,
): Promise<ConvertResult> {
  const base = getDoclingUrl();
  if (!base) throw new DoclingError('docling_not_configured', 'Docling URL is not configured');

  // 900s default. Use undici's headers/body timeouts (NOT global fetch, whose
  // own 300s headersTimeout would abort a long CPU convert before ours): docling
  // sends no response until it finishes (~1.3s/page → ~350s for 259 pages). The
  // wrapper's max_doc_pages guard fast-fails anything past this ceiling.
  const to = opts.timeoutMs ?? 900_000;
  const t0 = Date.now();
  try {
    const r = await undiciRequest(`${base}/v1/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sources: [{ kind: 'file', base64_string: base64, filename }],
        format: opts.format,
        ...(opts.recognizer ? { recognizer: opts.recognizer } : {}),
        ...(opts.schema !== undefined ? { schema: opts.schema } : {}),
        ...(opts.options ? { options: opts.options } : {}),
      }),
      headersTimeout: to,
      bodyTimeout: to,
    });
    if (r.statusCode < 200 || r.statusCode >= 300) {
      const body = await r.body.text().catch(() => '');
      if (r.statusCode === 413) throw new DoclingError('docling_too_large', body.slice(0, 300) || 'document too large');
      throw new DoclingError('docling_upstream', `Docling ${r.statusCode}: ${body.slice(0, 200)}`);
    }
    const json = (await r.body.json()) as ConvertApiResponse;
    if (json.error) throw new DoclingError('docling_upstream', json.error);
    const content = json.document?.content ?? '';
    logger.info('docling convert ok', {
      filename, format: opts.format, recognizer: json._recognizer, ms: Date.now() - t0,
    });
    return {
      content,
      format: json.document?.format ?? opts.format,
      recognizer: json._recognizer,
      pipeline: json._pipeline,
      ms: json._ms,
      warning: json.warning,
    };
  } catch (err) {
    if (err instanceof DoclingError) throw err;
    const code = (err as { code?: string })?.code;
    if (code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') {
      throw new DoclingError('docling_timeout', `Docling timed out converting "${filename}"`);
    }
    throw new DoclingError('docling_error', err instanceof Error ? err.message : String(err));
  }
}
