// Typed wrapper for the upload route.
//
// POST /upload is a multipart form route — it cannot use `apiCall` since
// it must not set Content-Type (the browser sets it with the boundary). The
// response is wrapped in the `{ data }` envelope (Wave 3 shape) so callers
// read `result.data` instead of the raw body.
//
// NOTE(wave4): ComfyUI's response shape (`{ name, subfolder, type }`) is
// preserved verbatim inside `data`. Define a strict schema and validate here
// in Wave 4.

import type { ErrorCode } from '@server/contracts/envelope.contract';
import { ApiClientError } from './error.js';

export interface UploadResult {
  name: string;
  subfolder: string;
  type?: string;
}

export async function uploadFile(file: File): Promise<UploadResult> {
  const form = new FormData();
  form.append('image', file);
  const res = await fetch('/api/upload', { method: 'POST', body: form });

  let body: unknown = null;
  try { body = await res.json(); } catch { /* non-JSON body */ }

  if (!res.ok) {
    // Canonical envelope error.
    if (body && typeof body === 'object' && 'error' in body) {
      const e = (body as { error: { code?: string; message?: string } }).error;
      throw new ApiClientError({
        code: (e.code as ErrorCode) ?? 'upstream_unavailable',
        status: res.status,
        message: e.message ?? `Upload failed: ${res.status}`,
      });
    }
    throw new ApiClientError({
      code: 'upstream_unavailable',
      status: res.status,
      message: `Upload failed: ${res.status} ${res.statusText}`,
    });
  }

  // Unwrap `{ data: ... }` envelope.
  if (body && typeof body === 'object' && 'data' in body) {
    return (body as { data: UploadResult }).data;
  }
  // Fallback: legacy shape without envelope (should not occur after Wave 3).
  return body as UploadResult;
}
