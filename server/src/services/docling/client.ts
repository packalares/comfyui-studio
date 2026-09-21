// Thin client for docling-serve (the local Docling document parser). Sends a
// base64 document to POST /v1/convert/source and returns the extracted
// markdown. Runs entirely against the in-cluster Service — no data leaves the
// box. The URL comes from settings (Tools → Docling); when unset, callers
// should treat file ingestion as disabled.

import { getDoclingUrl } from '../settings/index.js';
import { logger } from '../../lib/logger.js';

export class DoclingError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'DoclingError';
  }
}

interface ConvertResponse {
  document?: {
    md_content?: string | null;
    text_content?: string | null;
  };
  status?: string;
  errors?: unknown[];
}

/**
 * Convert one document (base64) to markdown text via docling-serve.
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
  const base = getDoclingUrl();
  if (!base) throw new DoclingError('docling_not_configured', 'Docling URL is not configured');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const r = await fetch(`${base}/v1/convert/source`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sources: [{ kind: 'file', base64_string: base64, filename }],
        options: { to_formats: ['md'], do_ocr: true },
      }),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new DoclingError('docling_upstream', `Docling ${r.status}: ${body.slice(0, 200)}`);
    }
    const json = (await r.json()) as ConvertResponse;
    const text = json.document?.md_content ?? json.document?.text_content ?? '';
    if (!text.trim()) {
      throw new DoclingError('docling_empty', `Docling returned no text for "${filename}"`);
    }
    logger.info('docling extract ok', { filename, chars: text.length, ms: Date.now() - t0 });
    return text;
  } catch (err) {
    if (err instanceof DoclingError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new DoclingError('docling_timeout', `Docling timed out parsing "${filename}"`);
    }
    throw new DoclingError('docling_error', err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

// ---- new multi-format endpoint (docling >= 1.2) -------------------------------
// The conversion service exposes POST /v1/convert with a selectable output
// `format` and OCR `recognizer`. `extractDocument` above (→ /v1/convert/source)
// stays for the markdown-into-chat path; use this when you want structured
// output (json/csv/tables/layout) or an explicit recognizer.

export type ConvertFormat =
  | 'markdown' | 'html' | 'text' | 'json' | 'layout-json' | 'csv' | 'tables';

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
  /** string for markdown/html/text/csv; object for json/layout-json; string[] for tables */
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

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 300_000);
  const t0 = Date.now();
  try {
    const r = await fetch(`${base}/v1/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sources: [{ kind: 'file', base64_string: base64, filename }],
        format: opts.format,
        ...(opts.recognizer ? { recognizer: opts.recognizer } : {}),
        ...(opts.schema !== undefined ? { schema: opts.schema } : {}),
        ...(opts.options ? { options: opts.options } : {}),
      }),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new DoclingError('docling_upstream', `Docling ${r.status}: ${body.slice(0, 200)}`);
    }
    const json = (await r.json()) as ConvertApiResponse;
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
    if (err instanceof Error && err.name === 'AbortError') {
      throw new DoclingError('docling_timeout', `Docling timed out converting "${filename}"`);
    }
    throw new DoclingError('docling_error', err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}
