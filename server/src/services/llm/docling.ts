// docling hook for the OpenAI LLM API. When a chat/completions request carries a
// `docling` field, the attached document is converted via the docling service.
// By default (`convert_only` defaults to true) the conversion is returned
// DIRECTLY, with no model turn — so /api/llm/v1/chat/completions doubles as a
// public, Bearer-gated, GPU-queued document-conversion API. With
// `convert_only:false` the converted content is injected as context and the
// model then answers.
//
//   "docling": true
//   "docling": { "format":"json", "schema":{...} }            // → returns fields
//   "docling": { "format":"csv", "recognizer":"dots" }        // → returns CSV
//   "docling": { "format":"markdown", "convert_only":false }  // → chat with it as context
//
// Field semantics match the wrapper: `recognizer` only affects scanned
// markdown/text/html/csv; `schema` only affects json; both are ignored elsewhere.

import type { ConvertFormat } from '../docling/client.js';

const FORMATS = new Set<ConvertFormat>(['markdown', 'html', 'text', 'json', 'csv']);
const RECOGNIZERS = new Set(['dots', 'paddle-vl']);

export interface DoclingRequest {
  enabled: boolean;
  format: ConvertFormat;
  recognizer?: 'dots' | 'paddle-vl';
  schema?: unknown;
  convertOnly: boolean;
}

/** Parse the per-request `docling` field. `convert_only` defaults to true. */
export function parseDoclingField(body: unknown): DoclingRequest {
  const raw = (body as { docling?: unknown } | null)?.docling;
  if (raw === true) return { enabled: true, format: 'markdown', convertOnly: true };
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    const format = (typeof o.format === 'string' && FORMATS.has(o.format as ConvertFormat)
      ? o.format : 'markdown') as ConvertFormat;
    const recognizer = (typeof o.recognizer === 'string' && RECOGNIZERS.has(o.recognizer)
      ? o.recognizer : undefined) as DoclingRequest['recognizer'];
    return {
      enabled: true,
      format,
      recognizer,
      schema: o.schema,
      convertOnly: o.convert_only !== false, // default true; only an explicit false opts out
    };
  }
  return { enabled: false, format: 'markdown', convertOnly: true };
}

type AnyRecord = Record<string, unknown>;

function stripDataUri(s: string): string {
  const comma = s.indexOf(',');
  return s.startsWith('data:') && comma >= 0 ? s.slice(comma + 1) : s;
}

export interface FoundDocument {
  base64: string;
  filename: string;
  /** Remove this attachment from the request body (used for convert_only:false). */
  remove: () => void;
}

/**
 * Find the first document attachment in the request — a top-level `attachments`
 * entry or an OpenAI `file`/`input_file` content part. Returns null if none.
 */
export function findDocument(body: unknown): FoundDocument | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as AnyRecord;

  if (Array.isArray(b.attachments)) {
    const arr = b.attachments as AnyRecord[];
    for (let i = 0; i < arr.length; i += 1) {
      const o = (arr[i] || {}) as AnyRecord;
      const data = (typeof o.data === 'string' && o.data) || (typeof o.base64 === 'string' && o.base64) || '';
      const filename = (typeof o.filename === 'string' && o.filename)
        || (typeof o.name === 'string' && o.name) || 'document';
      if (data) return { base64: stripDataUri(data), filename, remove: () => { arr.splice(i, 1); } };
    }
  }

  if (Array.isArray(b.messages)) {
    for (const msg of b.messages as AnyRecord[]) {
      if (!msg || !Array.isArray(msg.content)) continue;
      const content = msg.content as AnyRecord[];
      for (let i = 0; i < content.length; i += 1) {
        const p = (content[i] || {}) as AnyRecord;
        const file = p.file as AnyRecord | undefined;
        const isFile = p.type === 'file' || p.type === 'input_file' || (file && file.file_data) || p.file_data;
        if (!isFile) continue;
        const data = (file && typeof file.file_data === 'string' && file.file_data)
          || (typeof p.file_data === 'string' && p.file_data) || '';
        const filename = (file && typeof file.filename === 'string' && file.filename)
          || (typeof p.filename === 'string' && p.filename) || 'document';
        if (data) return { base64: stripDataUri(data), filename, remove: () => { content.splice(i, 1); } };
      }
    }
  }

  return null;
}

/** Inject converted content into the latest user message as a text part. */
export function injectContext(body: unknown, filename: string, content: unknown): void {
  const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  const block = `=== ${filename} ===\n${text}\n=== end of ${filename} ===`;
  const b = body as AnyRecord;
  const msgs = Array.isArray(b.messages) ? (b.messages as AnyRecord[]) : null;
  if (!msgs) return;
  let target: AnyRecord | undefined;
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    if (msgs[i]?.role === 'user') { target = msgs[i]; break; }
  }
  if (!target) { target = { role: 'user', content: [] }; msgs.push(target); }
  let c = target.content;
  if (typeof c === 'string') c = c ? [{ type: 'text', text: c }] : [];
  if (!Array.isArray(c)) c = [];
  (c as AnyRecord[]).unshift({ type: 'text', text: block });
  target.content = c;
}
