// Typed client for the UI-driven RAG endpoints.
// (Server side: `server/src/routes/rag.routes.ts`.)

import { fetchJson } from '../services/comfyui';

export interface RagflowKb {
  id: string;
  name: string;
  description?: string;
  documentCount?: number;
}

interface ListKbsResponse {
  kbs: RagflowKb[];
}

interface UploadResponse {
  ok: boolean;
  documentIds: string[];
}

export async function listRagKbs(): Promise<RagflowKb[]> {
  const data = await fetchJson<ListKbsResponse>('/rag/kbs');
  return data.kbs;
}

/**
 * Multipart upload to RAGFlow via Studio's `/api/rag/upload` proxy. Studio
 * spools the bytes through; nothing persists on Studio's disk after the
 * request returns.
 */
export async function uploadFileToKb(
  file: File,
  knowledgeBaseId: string,
): Promise<UploadResponse> {
  const form = new FormData();
  form.append('file', file, file.name);
  form.append('knowledgeBaseId', knowledgeBaseId);

  const res = await fetch('/api/rag/upload', { method: 'POST', body: form });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const msg = (body as { error?: string }).error ?? `${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
  return res.json() as Promise<UploadResponse>;
}
