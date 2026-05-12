// Reusable helper for uploading a local file to ComfyUI's input folder.
//
// Mirrors the multipart POST that `upload.routes.ts` performs for the HTTP
// upload path, but usable from any server-side service without going through
// the Express route. The file is streamed from disk via `fs.openAsBlob` so
// large video/audio files are not buffered in RAM.
//
// Only the `/api/upload/image` endpoint is used — ComfyUI accepts audio and
// video there too (same field name `image`), which is why the existing route
// also uses it for all media types.

import fs from 'fs';
import path from 'path';
import { env } from '../../config/env.js';

export interface ComfyUploadResult {
  name: string;
  subfolder: string;
  type: string;
}

/**
 * Upload a local file to ComfyUI's `/api/upload/image` endpoint and return
 * the parsed response `{ name, subfolder, type }`.
 *
 * `opts.type` defaults to `'input'` (the folder ComfyUI stores uploaded files
 * under). `opts.overwrite` defaults to false — let ComfyUI auto-rename on
 * collision so two users uploading the same filename don't clobber each other.
 */
export async function uploadFileToComfyUI(
  localPath: string,
  opts: { type?: 'input' | 'temp'; overwrite?: boolean; mimeType?: string } = {},
): Promise<ComfyUploadResult> {
  const mimeType = opts.mimeType ?? 'application/octet-stream';
  const blob = await fs.openAsBlob(localPath, { type: mimeType });
  const form = new FormData();
  // ComfyUI expects the file under the field name `image` regardless of media
  // type. The basename is the filename ComfyUI uses in its input folder.
  form.append('image', blob, path.basename(localPath));
  if (opts.type) form.append('type', opts.type);
  if (opts.overwrite) form.append('overwrite', 'true');

  const res = await fetch(`${env.COMFYUI_URL}/api/upload/image`, {
    method: 'POST',
    body: form,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`ComfyUI upload failed (${res.status}): ${detail}`);
  }

  const json = await res.json() as ComfyUploadResult;
  return json;
}

/**
 * Compose the widget value from a ComfyUI upload response.
 * The Studio UI sends `result.name` directly (Studio.tsx line 470:
 * `inputs[key] = result.name`). We do the same so the server-side upload path
 * produces an identical inputs shape and the injection in `inject.ts` writes
 * the correct filename onto the LoadImage/LoadAudio/LoadVideo node.
 */
export function comfyFilenameFromResult(result: ComfyUploadResult): string {
  return result.name;
}
