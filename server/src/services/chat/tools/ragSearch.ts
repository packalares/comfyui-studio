// `rag_search` chat tool — retrieves relevant chunks from a RAGFlow knowledge
// base via its HTTP API (`POST /api/v1/retrieval`).
//
// RAGFlow auth: `Authorization: Bearer <api_key>`. The endpoint accepts
// `dataset_ids: string[]` to scope retrieval; it MUST be non-empty per the
// public API contract, so a tool call without an explicit `knowledge_base_id`
// returns a structured error directing the user / model to pick one. (We
// intentionally don't auto-fan-out across every dataset because the API call
// would cost more than the LLM step itself on a populous tenant.)

import { tool } from 'ai';
import { z } from 'zod';

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

async function retrieve(args: RetrieveArgs): Promise<string> {
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
  return formatChunks(chunks, args.topK);
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
  return tool({
    description: 'Search the user\'s RAGFlow knowledge bases for relevant '
      + 'chunks. Each result includes the source document name plus the '
      + 'matching text — quote the chunks back when answering and cite the '
      + 'source document name.',
    inputSchema,
    execute: async ({ query, knowledge_base_id, top_k }) => {
      if (!knowledge_base_id) {
        return 'rag_search failed: knowledge_base_id is required. Ask the '
          + 'user which knowledge base to search before retrying.';
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
