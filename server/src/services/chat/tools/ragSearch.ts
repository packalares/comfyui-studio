// `rag_search` chat tool — retrieves relevant chunks from a RAGFlow knowledge
// base via its HTTP API (`POST /api/v1/retrieval`).
//
// RAGFlow auth: `Authorization: Bearer <api_key>`. The endpoint accepts
// `dataset_ids: string[]` to scope retrieval; it MUST be non-empty per the
// public API contract, so a tool call without an explicit `knowledge_base_id`
// returns a structured error directing the user / model to pick one. (We
// intentionally don't auto-fan-out across every dataset because the API call
// would cost more than the LLM step itself on a populous tenant.)
//
// Result envelope: when chunks are present we return a structured object
// `{ text, sources }` so the chat UI can render an ai-elements `<Sources>`
// block alongside the regular `<Tool>` card. The model only sees `text`
// (toolDispatch.toContentString unwraps it), keeping the existing tool-message
// shape unchanged.

import { z } from 'zod';
import { defineTool } from './defineTool.js';
import { TOOL_DESCRIPTION_RAG_SEARCH, RAG_SEARCH_NO_KB_ERROR } from '../prompts.js';

export interface RagSearchConfig {
  baseUrl: string;
  apiKey: string;
}

interface RagflowChunk {
  content?: string;
  content_with_weight?: string;
  document_keyword?: string;
  document_name?: string;
  document_id?: string;
  similarity?: number;
}

interface RagflowResponse {
  code?: number;
  message?: string;
  data?: {
    chunks?: RagflowChunk[];
    total?: number;
  };
}

/** Same shape as `WebSearchSource` so the UI can reuse one renderer. */
export interface RagSearchSource {
  title: string;
  url: string;
  snippet: string;
}
export interface RagSearchEnvelope {
  text: string;
  sources?: RagSearchSource[];
}
export type RagSearchOutput = string | RagSearchEnvelope;

const inputSchema = z.object({
  query: z.string().min(1)
    .describe('Natural-language question to retrieve relevant chunks for.'),
  knowledge_base_id: z.string().min(1).optional()
    .describe('RAGFlow dataset id to search within. Required — RAGFlow does '
      + 'not support cross-dataset retrieval in a single call.'),
  top_k: z.number().int().positive().max(20).optional()
    .describe('Maximum number of chunks to return (default 5, hard cap 20).'),
});

interface RetrieveArgs {
  baseUrl: string;
  apiKey: string;
  query: string;
  datasetId: string;
  topK: number;
}

async function retrieve(args: RetrieveArgs): Promise<RagSearchOutput> {
  const url = `${args.baseUrl}/api/v1/retrieval`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${args.apiKey}`,
      },
      body: JSON.stringify({
        question: args.query,
        dataset_ids: [args.datasetId],
        top_k: args.topK,
      }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    return `rag_search failed: RAGFlow returned ${res.status} ${res.statusText}.`;
  }
  const body = await res.json() as RagflowResponse;
  if (typeof body.code === 'number' && body.code !== 0) {
    return `rag_search failed: ${body.message ?? `RAGFlow code ${body.code}`}.`;
  }
  const chunks = body.data?.chunks ?? [];
  if (chunks.length === 0) {
    return `No matching chunks for "${args.query}" in dataset ${args.datasetId}.`;
  }
  const text = formatChunks(chunks, args.topK);
  const sources = _toSources(args.baseUrl, chunks.slice(0, args.topK));
  return { text, sources };
}

/** Map RAGFlow chunks onto a `WebSearchSource`-compatible shape. URL points at
 *  the RAGFlow document download endpoint when a `document_id` is available
 *  so InlineCitation can render a working link; otherwise fall back to a
 *  synthetic `ragflow:` href so the row still renders (UI degrades gracefully
 *  to a plain text source — no `new URL()` failure since we always emit a
 *  scheme). */
export function _toSources(
  baseUrl: string,
  chunks: RagflowChunk[],
): RagSearchSource[] {
  const out: RagSearchSource[] = [];
  for (const c of chunks) {
    const docName = (c.document_keyword ?? c.document_name ?? '').trim();
    const id = (c.document_id ?? '').trim();
    const url = id
      ? `${baseUrl}/api/v1/document/${encodeURIComponent(id)}`
      : `ragflow://${encodeURIComponent(docName || 'chunk')}`;
    out.push({
      title: docName || '(untitled chunk)',
      url,
      snippet: (c.content_with_weight ?? c.content ?? '').trim(),
    });
  }
  return out;
}

export function formatChunks(chunks: RagflowChunk[], topK: number): string {
  const top = chunks.slice(0, topK);
  const lines: string[] = [];
  top.forEach((c, i) => {
    const text = (c.content_with_weight ?? c.content ?? '').trim();
    const doc = (c.document_keyword ?? c.document_name ?? '').trim();
    const sim = typeof c.similarity === 'number' ? ` (similarity ${c.similarity.toFixed(2)})` : '';
    const head = doc ? `${i + 1}. ${doc}${sim}` : `${i + 1}. (chunk)${sim}`;
    lines.push(head);
    if (text) lines.push(text);
    lines.push('');
  });
  return lines.join('\n').trimEnd();
}

export function ragSearchTool(config: RagSearchConfig) {
  return defineTool({
    description: TOOL_DESCRIPTION_RAG_SEARCH,
    inputSchema,
    execute: async ({ query, knowledge_base_id, top_k }): Promise<RagSearchOutput> => {
      if (!knowledge_base_id) {
        return RAG_SEARCH_NO_KB_ERROR;
      }
      const k = typeof top_k === 'number' ? Math.max(1, Math.min(20, top_k)) : 5;
      try {
        return await retrieve({
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          query,
          datasetId: knowledge_base_id,
          topK: k,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `rag_search failed: ${msg}`;
      }
    },
  });
}
