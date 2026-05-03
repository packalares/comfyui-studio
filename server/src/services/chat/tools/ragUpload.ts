// `rag_upload` chat tool — fetch a URL and stream the body to RAGFlow's
// `POST /api/v1/datasets/{dataset_id}/documents` upload endpoint as a
// multipart form. RAGFlow returns the new document id(s) in `data` on
// success.
//
// v1 scope: pass-through only. The chat composer doesn't yet support
// drag-and-drop uploads — the LLM's job here is to grab a URL the user
// already mentioned in conversation and stash it in the KB.

import { tool } from 'ai';
import { z } from 'zod';
import { TOOL_DESCRIPTION_RAG_UPLOAD } from '../prompts.js';

export interface RagUploadConfig {
  baseUrl: string;
  apiKey: string;
}

interface RagflowUploadResponse {
  code?: number;
  message?: string;
  data?: Array<{ id?: string; name?: string }>;
}

const inputSchema = z.object({
  file_url: z.string().url()
    .describe('Public HTTPS URL to fetch and upload. The server downloads '
      + 'the body and forwards it to RAGFlow as the document content.'),
  knowledge_base_id: z.string().min(1)
    .describe('RAGFlow dataset id to attach the uploaded document to.'),
});

function filenameFromUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
    if (last.length > 0) return last;
  } catch { /* fall through */ }
  return 'upload.bin';
}

interface UploadArgs {
  baseUrl: string;
  apiKey: string;
  fileUrl: string;
  datasetId: string;
}

async function uploadFromUrl(args: UploadArgs): Promise<string> {
  // 60 s budget covers fetch + RAGFlow ingest for typical PDFs / docs.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const fetched = await fetch(args.fileUrl, { signal: ctrl.signal });
    if (!fetched.ok) {
      return `rag_upload failed: source URL returned ${fetched.status} ${fetched.statusText}.`;
    }
    const blob = await fetched.blob();
    const form = new FormData();
    form.append('file', blob, filenameFromUrl(args.fileUrl));
    const url = `${args.baseUrl}/api/v1/datasets/${encodeURIComponent(args.datasetId)}/documents`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${args.apiKey}` },
      body: form,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      return `rag_upload failed: RAGFlow returned ${res.status} ${res.statusText}.`;
    }
    const body = await res.json() as RagflowUploadResponse;
    if (typeof body.code === 'number' && body.code !== 0) {
      return `rag_upload failed: ${body.message ?? `RAGFlow code ${body.code}`}.`;
    }
    const docs = Array.isArray(body.data) ? body.data : [];
    if (docs.length === 0) {
      return 'rag_upload: RAGFlow accepted the request but did not return a document id.';
    }
    const ids = docs.map((d) => d.id).filter((id): id is string => typeof id === 'string');
    return `rag_upload succeeded. Document ids: ${ids.join(', ')}. `
      + 'RAGFlow will index the file in the background.';
  } finally {
    clearTimeout(timer);
  }
}

export function ragUploadTool(config: RagUploadConfig) {
  return tool({
    description: TOOL_DESCRIPTION_RAG_UPLOAD,
    inputSchema,
    execute: async ({ file_url, knowledge_base_id }) => {
      try {
        return await uploadFromUrl({
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          fileUrl: file_url,
          datasetId: knowledge_base_id,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `rag_upload failed: ${msg}`;
      }
    },
  });
}
