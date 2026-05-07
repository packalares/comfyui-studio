// Helpers for the UI-driven RAG upload flow. Distinct from the
// LLM-driven `chat/tools/ragUpload.ts` tool which only takes a public URL —
// here we accept multipart bytes from the browser and forward them to
// RAGFlow's `POST /api/v1/datasets/{id}/documents` endpoint.

import * as toolsSettings from './settings.tools.js';
import { logger } from '../lib/logger.js';

const REQUEST_TIMEOUT_MS = 120_000;

export interface RagflowKb {
  id: string;
  name: string;
  description?: string;
  documentCount?: number;
}

interface RagflowDataset {
  id?: string;
  name?: string;
  description?: string;
  document_count?: number;
}

interface RagflowEnvelope<T> {
  code?: number;
  message?: string;
  data?: T;
}

function resolveCreds(): { baseUrl: string; apiKey: string } {
  const baseUrl = toolsSettings.getRagflowUrl();
  const apiKey = toolsSettings.getRagflowApiKey();
  if (!baseUrl) throw new Error('RAGFlow URL not configured (Settings → Tools).');
  if (!apiKey) throw new Error('RAGFlow API key not configured (Settings → Tools).');
  return { baseUrl, apiKey };
}

/** Fetch the user's knowledge bases from RAGFlow. The shape RAGFlow returns
 *  is `{ code, data: [{ id, name, description, document_count, ... }] }` so
 *  we narrow to just the fields the picker needs. */
export async function listKnowledgeBases(): Promise<RagflowKb[]> {
  const { baseUrl, apiKey } = resolveCreds();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/v1/datasets`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`RAGFlow ${res.status} ${res.statusText}`);
    }
    const body = await res.json() as RagflowEnvelope<RagflowDataset[]>;
    if (typeof body.code === 'number' && body.code !== 0) {
      throw new Error(body.message ?? `RAGFlow code ${body.code}`);
    }
    const list = Array.isArray(body.data) ? body.data : [];
    return list
      .filter((d): d is RagflowDataset & { id: string; name: string } =>
        typeof d.id === 'string' && typeof d.name === 'string')
      .map(d => ({
        id: d.id,
        name: d.name,
        description: typeof d.description === 'string' ? d.description : undefined,
        documentCount: typeof d.document_count === 'number' ? d.document_count : undefined,
      }));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Forward a file's bytes to RAGFlow as a multipart upload to the given
 * dataset. Returns the document id(s) RAGFlow assigns. Doesn't persist
 * the file on Studio's side — bytes flow through.
 */
export async function uploadFileToKb(
  buf: Buffer,
  filename: string,
  knowledgeBaseId: string,
): Promise<{ documentIds: string[] }> {
  const { baseUrl, apiKey } = resolveCreds();

  const blob = new Blob([buf]);
  const form = new FormData();
  form.append('file', blob, filename);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const url = `${baseUrl.replace(/\/+$/, '')}/api/v1/datasets/${encodeURIComponent(knowledgeBaseId)}/documents`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`RAGFlow ${res.status} ${res.statusText}`);
    }
    const body = await res.json() as RagflowEnvelope<Array<{ id?: string }>>;
    if (typeof body.code === 'number' && body.code !== 0) {
      throw new Error(body.message ?? `RAGFlow code ${body.code}`);
    }
    const docs = Array.isArray(body.data) ? body.data : [];
    const documentIds = docs
      .map(d => d.id)
      .filter((id): id is string => typeof id === 'string');
    if (documentIds.length === 0) {
      logger.warn('rag upload: RAGFlow accepted but returned no document id', {
        filename, kb: knowledgeBaseId,
      });
    }
    return { documentIds };
  } finally {
    clearTimeout(timer);
  }
}
