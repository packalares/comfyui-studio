// Resolve chat-message attachments into template form-input values for
// upload-type fields (`image` / `mask` / `audio` / `video`).
//
// Called by the `generate_image` chat tool and the MCP `studio_submit_generation`
// tool before calling `submitTemplate`. The result tells the caller:
//   - `filledInputs`          — keyed by the form field id (same key the Studio
//                                UI uses), value = ComfyUI filename from the upload.
//   - `unmatchedRequiredFields` — field labels the user still needs to attach.
//
// Attachments are taken conversation-wide, newest first — the file may have
// been attached an earlier turn, and the tool-side `messageId` is the
// assistant's placeholder, not the user's message. Matching is positional by
// media class (image / audio / video): the Nth (newest-first) attachment of a
// media class fills the Nth upload field of the same class, in field
// declaration order. If a template has no upload fields and there are no
// attachments, this returns empty results with no error.

import path from 'path';
import {
  listAttachmentsForMessage,
  listUserAttachmentsForConversation,
} from '../../lib/db/chat.repo.js';
import type { AttachmentRow } from '../../lib/db/chat.repo.js';
import { attachmentDir } from './attachments.js';
import { getTemplate } from '../templates/index.js';
import { generateFormInputs } from '../templates/templates.formInputs.js';
import { fetchTemplateWorkflow } from '../templates/dependencyCheck.js';
import { getObjectInfo } from '../workflow/index.js';
import type { FormInputData } from '../templates/types.js';
import { uploadFileToComfyUI, comfyFilenameFromResult } from '../comfyui/upload.js';
import type { RawTemplate } from '../templates/types.js';

// The form field types we treat as upload slots.
type UploadFieldType = 'image' | 'mask' | 'audio' | 'video';
const UPLOAD_FIELD_TYPES = new Set<string>(['image', 'mask', 'audio', 'video']);

// Media-class grouping: mask uploads are images at the MIME level.
type MediaClass = 'image' | 'audio' | 'video';

function mediaClassOf(mime: string): MediaClass | null {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return null;
}

// Mask fields carry `type: 'mask'` but accept image files — map them to the
// `image` media class so the user's attached image fills both image and mask
// upload slots in order.
function mediaClassForField(type: UploadFieldType): MediaClass {
  if (type === 'mask') return 'image';
  return type as MediaClass;
}

export interface AttachmentTemplateInputsResult {
  /** Form-input id → ComfyUI filename, ready to merge into `submitTemplate` inputs. */
  filledInputs: Record<string, string>;
  /** Labels of required upload fields that had no matching attachment. */
  unmatchedRequiredFields: string[];
}

/**
 * Match message attachments to template upload fields and upload matched
 * files to ComfyUI. Returns filled input values and any unmatched required
 * fields.
 *
 * Pass `conversationId` when available (chat path) — attachments are then
 * resolved across the whole conversation, newest first. `messageId` is only a
 * fallback when there's no conversation id. When neither is given (raw MCP
 * client), this behaves as if there are no attachments.
 */
export async function resolveAttachmentTemplateInputs(
  opts: {
    templateName: string;
    conversationId?: string;
    messageId?: string;
  },
): Promise<AttachmentTemplateInputsResult> {
  const empty: AttachmentTemplateInputsResult = {
    filledInputs: {},
    unmatchedRequiredFields: [],
  };

  const template = getTemplate(opts.templateName);
  if (!template) return empty;

  // Build the form-input plan (same call chain as submitTemplate).
  const rawTemplate: RawTemplate = {
    name: template.name,
    title: template.title,
    description: template.description,
    mediaType: template.mediaType,
    tags: template.tags,
    models: template.models,
    io: template.io,
  };
  let workflow: Record<string, unknown> | undefined;
  try {
    const wf = await fetchTemplateWorkflow(opts.templateName);
    if (wf) workflow = wf;
  } catch { /* workflow fetch failures are non-fatal here */ }

  let objectInfo: Record<string, Record<string, unknown>> = {};
  try {
    objectInfo = await getObjectInfo();
  } catch { /* objectInfo fetch failures are non-fatal */ }

  const formInputs = generateFormInputs(rawTemplate, workflow, objectInfo);
  const uploadFields = formInputs.filter(
    (f): f is FormInputData & { type: UploadFieldType } =>
      UPLOAD_FIELD_TYPES.has(f.type),
  );

  if (uploadFields.length === 0) return empty;

  // Load attachments: prefer the conversation-wide list (newest first) so a
  // file attached an earlier turn still resolves; fall back to per-message.
  const attachmentRows: AttachmentRow[] = opts.conversationId
    ? listUserAttachmentsForConversation(opts.conversationId)
    : opts.messageId
      ? listAttachmentsForMessage(opts.messageId)
      : [];

  // If the template has upload fields but there are no attachments at all,
  // all required upload fields are unmatched.
  if (attachmentRows.length === 0) {
    const unmatched = uploadFields
      .filter((f) => f.required)
      .map((f) => f.label || f.id);
    return { filledInputs: {}, unmatchedRequiredFields: unmatched };
  }

  // Group attachments by media class, preserving order.
  const byClass: Record<MediaClass, AttachmentRow[]> = {
    image: [],
    audio: [],
    video: [],
  };
  for (const row of attachmentRows) {
    const cls = mediaClassOf(row.mime_type);
    if (cls) byClass[cls].push(row);
  }

  // Pair each upload field with the next attachment of its media class.
  const consumed: Record<MediaClass, number> = { image: 0, audio: 0, video: 0 };
  const filledInputs: Record<string, string> = {};
  const unmatchedRequiredFields: string[] = [];
  const dir = attachmentDir();

  for (const field of uploadFields) {
    const cls = mediaClassForField(field.type);
    const idx = consumed[cls];
    const row = byClass[cls][idx];

    if (!row) {
      if (field.required) unmatchedRequiredFields.push(field.label || field.id);
      continue;
    }

    consumed[cls] += 1;
    const localPath = path.join(dir, `${row.id}.${row.ext}`);

    try {
      const uploaded = await uploadFileToComfyUI(localPath, { mimeType: row.mime_type });
      filledInputs[field.id] = comfyFilenameFromResult(uploaded);
    } catch (err) {
      // Upload failure for a required field is treated as unmatched — the
      // caller will surface it as "needs attachment" rather than silently
      // submitting without the file.
      if (field.required) {
        unmatchedRequiredFields.push(field.label || field.id);
      }
    }
  }

  return { filledInputs, unmatchedRequiredFields };
}
