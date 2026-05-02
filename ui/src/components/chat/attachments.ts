// Shared attachment helpers for the chat composer + message rendering.
//
// Attachments live in the same `parts` JSON the rest of the chat persists
// (Ollama `images: []` is derived server-side from `file` parts whose
// mediaType starts with `image/` — see `convertToOllamaMessages` in the
// server's `ollamaChat.ts`). For text / code uploads we inline the extracted
// content directly into the user's text so any model can reason over it.
//
// `buildUserUIMessageParts` (in `studioMessages.ts`) is the Phase E
// successor to the old `buildUserMessageParts` helper that lived here — the
// chat page now goes straight to a `UIMessage` shape rather than the
// persisted-wire shape and lets `useChat` round-trip it through the
// transport.

// Heuristic vision-capable model match. The chat library response may carry
// authoritative `capabilities: ['vision']` for known catalog entries — we
// fall back to a name-pattern match for installed-only models that aren't
// in the public library (custom HF pulls, fine-tunes).
const VISION_NAME_PATTERNS: RegExp[] = [
  /(^|[/:_-])gemma\s*3/i,
  /(^|[/:_-])gemma\s*4/i,
  /llama.*vision/i,
  /llava/i,
  /qwen.*vl/i,
  /qwen2\.?5vl/i,
  /minicpm-v/i,
  /bakllava/i,
  /moondream/i,
  /llama3\.2-vision/i,
  /llama4/i,
];

export function modelIsVisionCapable(modelName: string, libraryCaps?: string[] | null): boolean {
  if (libraryCaps && libraryCaps.includes('vision')) return true;
  return VISION_NAME_PATTERNS.some((rx) => rx.test(modelName));
}

export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
// 50 KB cap on inlined text content so a careless 5 MB log paste doesn't blow
// the prompt context.
export const MAX_TEXT_INLINE_BYTES = 50 * 1024;

export const ALLOWED_ACCEPT =
  'image/png,image/jpeg,image/webp,image/gif,.pdf,.txt,.md,.json,.py,.js,.ts,.tsx,.jsx,.html,.css,.csv,.yaml,.yml,.toml,.xml,.log';

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'py', 'js', 'jsx', 'ts', 'tsx', 'html',
  'htm', 'css', 'csv', 'yaml', 'yml', 'toml', 'xml', 'log', 'sh', 'rb',
  'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'php', 'sql', 'env',
  'ini', 'conf',
]);

export type AttachmentKind = 'image' | 'text' | 'pdf' | 'unsupported';

export interface PendingAttachment {
  id: string;
  kind: AttachmentKind;
  filename: string;
  size: number;
  mimeType: string;
  // For images: data URL kept as-is (`data:image/png;base64,...`) so the
  // composer thumb + the persisted `file` part both reuse the same string
  // without an extra encode pass.
  dataUrl?: string;
  // Inlined text content (bounded by MAX_TEXT_INLINE_BYTES).
  textContent?: string;
}

export function classifyFile(file: File): AttachmentKind {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) return 'pdf';
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (file.type.startsWith('text/') || TEXT_EXTENSIONS.has(ext)) return 'text';
  return 'unsupported';
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ''));
    r.onerror = () => reject(r.error ?? new Error('read failed'));
    r.readAsDataURL(file);
  });
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ''));
    r.onerror = () => reject(r.error ?? new Error('read failed'));
    // Reading the whole file (up to 20 MB) — cap is applied after read so we
    // can still surface the original size on the chip.
    r.readAsText(file);
  });
}

function makeId(): string {
  return 'att_' + Math.random().toString(36).slice(2, 12);
}

export interface ProcessedFile {
  ok: true;
  attachment: PendingAttachment;
}
export interface RejectedFile {
  ok: false;
  filename: string;
  reason: string;
}
export type ProcessResult = ProcessedFile | RejectedFile;

export async function processFile(file: File): Promise<ProcessResult> {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return { ok: false, filename: file.name, reason: 'File is larger than 20 MB' };
  }
  const kind = classifyFile(file);
  if (kind === 'pdf') {
    // PDF support intentionally deferred — pdfjs-dist would add ~1 MB to the
    // bundle and require a worker setup. Surface a clear rejection so the
    // user knows it's not a silent drop.
    return { ok: false, filename: file.name, reason: 'PDFs are not supported yet — paste the text directly or convert to .txt/.md.' };
  }
  if (kind === 'unsupported') {
    return { ok: false, filename: file.name, reason: 'Unsupported file type' };
  }
  if (kind === 'image') {
    try {
      const dataUrl = await readAsDataUrl(file);
      return {
        ok: true,
        attachment: {
          id: makeId(),
          kind: 'image',
          filename: file.name,
          size: file.size,
          mimeType: file.type || 'image/png',
          dataUrl,
        },
      };
    } catch (err) {
      return { ok: false, filename: file.name, reason: err instanceof Error ? err.message : 'read failed' };
    }
  }
  // text
  try {
    const raw = await readAsText(file);
    const textContent = raw.length > MAX_TEXT_INLINE_BYTES
      ? raw.slice(0, MAX_TEXT_INLINE_BYTES) + `\n\n[truncated — file was ${formatBytes(file.size)}]`
      : raw;
    return {
      ok: true,
      attachment: {
        id: makeId(),
        kind: 'text',
        filename: file.name,
        size: file.size,
        mimeType: file.type || 'text/plain',
        textContent,
      },
    };
  } catch (err) {
    return { ok: false, filename: file.name, reason: err instanceof Error ? err.message : 'read failed' };
  }
}

