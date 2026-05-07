// Helpers for surfacing rich UI affordances out of `StudioUIMessage` parts:
//
// * `collectToolSources` walks `dynamic-tool` parts and pulls a typed
//   `{ title, url, snippet }` list out of `web_search` / `rag_search` results
//   so the thread can render an ai-elements `<Sources>` block alongside the
//   tool card.
// * `extractGenerateImageRefs` finds `generate_image` tool calls that
//   produced a `promptId`, so the renderer can subscribe to `gallery:added`
//   events and swap in the resulting image when ComfyUI finishes the run.
// * `extractInlineUrls` scans assistant text for plain URLs (so the optional
//   `<WebPreview>` rendering can show an iframe per detected URL).
// * `deriveSuggestions` produces 2-3 static follow-up prompts based on the
//   last assistant content shape, no extra LLM call required.
//
// These helpers are pure / synchronous so the component file doesn't accrue
// hundreds of lines of array-walks inline.

import type { StudioUIMessage, StudioUIMessagePart } from './studioMessages';
import type { ContextualSuggestionGroups } from '../../services/comfyui';

/** Source row consumed by `<Sources>` / `<InlineCitation>`. Mirrors the
 *  server-side `WebSearchSource` / `RagSearchSource` shape. */
export interface ToolSource {
  title: string;
  url: string;
  snippet: string;
}

export interface ToolSourceList {
  toolName: 'web_search' | 'rag_search';
  toolCallId: string;
  sources: ToolSource[];
}

interface RawSourceLike { title?: unknown; url?: unknown; snippet?: unknown }

function normalizeSource(raw: unknown): ToolSource | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as RawSourceLike;
  const url = typeof r.url === 'string' ? r.url.trim() : '';
  if (!url) return null;
  return {
    title: typeof r.title === 'string' && r.title.trim() ? r.title.trim() : url,
    url,
    snippet: typeof r.snippet === 'string' ? r.snippet.trim() : '',
  };
}

/** Extract `{ sources: [...] }` envelopes from this message's tool parts.
 *  Returns one `ToolSourceList` per qualifying call (so multi-search turns
 *  show a `<Sources>` block per call rather than a merged blob). */
export function collectToolSources(parts: StudioUIMessagePart[]): ToolSourceList[] {
  const out: ToolSourceList[] = [];
  for (const p of parts) {
    if (p.type !== 'dynamic-tool') continue;
    if (p.toolName !== 'web_search' && p.toolName !== 'rag_search') continue;
    if (p.state !== 'output-available') continue;
    const output = p.output;
    if (!output || typeof output !== 'object') continue;
    const rawSources = (output as { sources?: unknown }).sources;
    if (!Array.isArray(rawSources)) continue;
    const sources = rawSources
      .map(normalizeSource)
      .filter((s): s is ToolSource => s !== null);
    if (sources.length === 0) continue;
    out.push({
      toolName: p.toolName,
      toolCallId: p.toolCallId,
      sources,
    });
  }
  return out;
}

export interface GenerateImageRef {
  toolCallId: string;
  promptId: string;
  templateName: string;
}

/** Pull out `generate_image` tool calls that emitted a `promptId`. The
 *  renderer subscribes to `gallery:added` events filtered by `promptId` to
 *  swap a placeholder for the rendered image when it lands. */
export function extractGenerateImageRefs(parts: StudioUIMessagePart[]): GenerateImageRef[] {
  const out: GenerateImageRef[] = [];
  for (const p of parts) {
    if (p.type !== 'dynamic-tool') continue;
    if (p.toolName !== 'generate_image') continue;
    if (p.state !== 'output-available') continue;
    const output = p.output;
    if (!output || typeof output !== 'object') continue;
    const promptId = (output as { promptId?: unknown }).promptId;
    if (typeof promptId !== 'string' || promptId.length === 0) continue;
    const templateName = (output as { templateName?: unknown }).templateName;
    out.push({
      toolCallId: p.toolCallId,
      promptId,
      templateName: typeof templateName === 'string' ? templateName : '',
    });
  }
  return out;
}

/** Inline-binary content that an MCP tool produced (screenshot, PDF, etc.).
 *  The server's `toolMediaPersist` saves the bytes to chat-attachments and
 *  rewrites the tool result to a small URL string; the renderer detects
 *  that URL and inlines an `<img>` / download link beside the tool card. */
export interface ToolAttachment {
  toolCallId: string;
  toolName: string;
  url: string;
  filename: string;
  kind: 'image' | 'pdf' | 'audio' | 'video' | 'file';
}

const ATTACHMENT_URL_RX = /\/api\/chat\/attachments\/([A-Za-z0-9._-]+\.[A-Za-z0-9]+)/g;

function classifyByExt(filename: string): ToolAttachment['kind'] {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'].includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(ext)) return 'audio';
  if (['mp4', 'webm', 'mov', 'mkv'].includes(ext)) return 'video';
  return 'file';
}

/** Walk every dynamic-tool part on a message and pull out the attachment
 *  references the server's `toolMediaPersist` left in the tool result.
 *  Output entries are deduped by URL so the same screenshot listed twice
 *  in one tool reply doesn't render twice. */
export function extractToolAttachments(parts: StudioUIMessagePart[]): ToolAttachment[] {
  const out: ToolAttachment[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    if (p.type !== 'dynamic-tool') continue;
    if (p.state !== 'output-available') continue;
    const output = p.output;
    if (!output) continue;
    const text = typeof output === 'string' ? output : JSON.stringify(output);
    let m: RegExpExecArray | null;
    ATTACHMENT_URL_RX.lastIndex = 0;
    while ((m = ATTACHMENT_URL_RX.exec(text)) !== null) {
      const filename = m[1];
      const url = `/api/chat/attachments/${filename}`;
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({
        toolCallId: p.toolCallId,
        toolName: p.toolName,
        url,
        filename,
        kind: classifyByExt(filename),
      });
    }
  }
  return out;
}

// Permissive URL regex — captures `http(s)://...` up to whitespace or a
// trailing punctuation char that's almost always punctuation rather than a
// URL ending. Markdown link wrappers `[text](url)` are matched too because
// the `(url)` group still parses cleanly.
const URL_RX = /(https?:\/\/[^\s)\]]+[^\s)\].,;!?])/g;

/** Find unique URLs embedded in plain text. Used for the opt-in `<WebPreview>`
 *  rendering path under assistant messages. Returns at most 3 URLs to keep
 *  the DOM cost bounded — long answers with citation soup would otherwise
 *  produce a forest of iframes. */
export function extractInlineUrls(text: string, max = 3): string[] {
  if (!text) return [];
  const matches = text.match(URL_RX);
  if (!matches) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matches) {
    if (seen.has(m)) continue;
    seen.add(m);
    out.push(m);
    if (out.length >= max) break;
  }
  return out;
}

/** Static, no-extra-LLM follow-up suggestions keyed off the assistant's
 *  reply shape. Picked deliberately lo-fi (no async / no token spend).
 *  The contextual groups come from `system.chat.suggestions.contextual`,
 *  hydrated server-side from `data/chat/default_prompts.md` — pass the
 *  whole map as the second arg. Empty arrays render as "no suggestions"
 *  (the caller falls back to dynamic server suggestions when present). */
export function deriveSuggestions(
  message: StudioUIMessage,
  contextual: ContextualSuggestionGroups | null,
): string[] {
  const text = message.parts
    .filter(p => p.type === 'text')
    .map(p => (p as { text: string }).text)
    .join('')
    .trim();
  if (!text) return [];
  if (!contextual) return [];

  const lower = text.toLowerCase();
  const hasCodeFence = /```/.test(text);
  const endsWithQuestion = /\?\s*$/.test(text);
  const hasUrl = /https?:\/\//.test(text);

  const out: string[] = [];
  if (hasCodeFence) out.push(...contextual.codeFenced);
  if (hasUrl) out.push(...contextual.urlBearing);
  if (endsWithQuestion) out.push(...contextual.question);
  if (out.length === 0) {
    out.push(...contextual.fallback);
    if (lower.length > 400 && contextual.longReplyExtra) {
      out.push(contextual.longReplyExtra);
    }
  }
  // De-dupe (e.g. "Tell me more" can appear via multiple branches) + cap.
  const seen = new Set<string>();
  const dedup: string[] = [];
  for (const s of out) {
    if (seen.has(s)) continue;
    seen.add(s);
    dedup.push(s);
    if (dedup.length >= 3) break;
  }
  return dedup;
}
