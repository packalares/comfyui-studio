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
import { CONTEXTUAL_SUGGESTIONS } from '../../config/chat-suggestions';

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
 *  reply shape. Picked deliberately lo-fi (no async / no token spend) —
 *  the brief flagged "Option A (cheap)". */
export function deriveSuggestions(message: StudioUIMessage): string[] {
  const text = message.parts
    .filter(p => p.type === 'text')
    .map(p => (p as { text: string }).text)
    .join('')
    .trim();
  if (!text) return [];

  const lower = text.toLowerCase();
  const hasCodeFence = /```/.test(text);
  const endsWithQuestion = /\?\s*$/.test(text);
  const hasUrl = /https?:\/\//.test(text);

  const out: string[] = [];
  if (hasCodeFence) {
    out.push(...CONTEXTUAL_SUGGESTIONS.codeFenced);
  }
  if (hasUrl) {
    out.push(...CONTEXTUAL_SUGGESTIONS.urlBearing);
  }
  if (endsWithQuestion) {
    out.push(...CONTEXTUAL_SUGGESTIONS.question);
  }
  if (out.length === 0) {
    out.push(...CONTEXTUAL_SUGGESTIONS.fallback);
    if (lower.length > 400) out.push(CONTEXTUAL_SUGGESTIONS.longReplyExtra);
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
