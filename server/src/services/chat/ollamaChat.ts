// Helpers for talking to Ollama's native `/api/chat` NDJSON endpoint.
//
// Lives apart from streamChat.ts so the conversion + frame-parsing logic can
// be unit-tested without spinning up a real Ollama server, and so the parent
// streamer stays under the 250-line cap.

import type { UIMessage } from 'ai';

/** A native Ollama chat message — the wire shape we POST to /api/chat. */
export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Base64 image strings (no data: prefix) for multimodal models. */
  images?: string[];
}

/**
 * Final NDJSON frame fields surfaced by Ollama once `done: true`. All
 * `*_duration` values are nanoseconds. See
 * https://github.com/ollama/ollama/blob/main/docs/api.md#generate-a-chat-completion
 */
export interface OllamaFinalFrame {
  done?: boolean;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
  message?: { role?: string; content?: string };
}

/** Compact telemetry stamped on the final frame. */
export interface OllamaTelemetry {
  tokens_in: number | null;
  tokens_out: number | null;
  /** Tokens-per-second over generation only (excludes prompt eval), matching `ollama` CLI. */
  tokens_per_sec: number | null;
  /** Total wall time reported by Ollama, in milliseconds. */
  ms_total_ollama: number | null;
  /** Time spent loading the model, in milliseconds (0 for warm models). */
  ms_load: number | null;
}

/**
 * Project a UIMessage[] (AI SDK) into Ollama's native message wire shape.
 * Text parts concatenate into `content`; file parts whose mediaType starts
 * with `image/` become base64 entries on `images` (ignoring non-data URLs
 * since Ollama only accepts inline base64).
 *
 * Phase F: only the LATEST user message keeps its images. Prior-turn images
 * are stripped because each base64 attachment burns 1-2K tokens of context;
 * for follow-up turns the model already extracted what it needs in its own
 * reply, and the image bytes rarely add value relative to their cost.
 */
export function convertToOllamaMessages(
  messages: UIMessage[],
  systemPrompt: string | null,
): OllamaChatMessage[] {
  const out: OllamaChatMessage[] = [];
  if (systemPrompt && systemPrompt.length > 0) {
    out.push({ role: 'system', content: systemPrompt });
  }
  // Locate the LAST user message — only that one gets to keep images.
  let latestUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') { latestUserIdx = i; break; }
  }
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'system') continue;
    const textChunks: string[] = [];
    const images: string[] = [];
    const allowImages = i === latestUserIdx;
    for (const part of m.parts ?? []) {
      const p = part as { type?: string; text?: string; mediaType?: string; url?: string };
      if (p.type === 'text' && typeof p.text === 'string') {
        textChunks.push(p.text);
      } else if (p.type === 'reasoning' && typeof p.text === 'string') {
        // Ollama doesn't have a separate reasoning channel — fold it into the
        // assistant content so the dialog stays coherent on follow-up turns.
        textChunks.push(p.text);
      } else if (p.type === 'file' && typeof p.url === 'string'
                 && typeof p.mediaType === 'string'
                 && p.mediaType.startsWith('image/')) {
        if (!allowImages) continue;
        const b64 = extractBase64FromDataUrl(p.url);
        if (b64) images.push(b64);
      }
    }
    const content = textChunks.join('\n').trim();
    if (content.length === 0 && images.length === 0) continue;
    const msg: OllamaChatMessage = { role: m.role, content };
    if (images.length > 0) msg.images = images;
    out.push(msg);
  }
  return out;
}

/** Parse a `data:image/...;base64,XXX` URL down to its base64 payload. */
export function extractBase64FromDataUrl(url: string): string | null {
  const m = /^data:[^;]+;base64,(.+)$/.exec(url);
  if (!m) return null;
  return m[1];
}

/**
 * Reduce Ollama's final NDJSON frame to the telemetry columns persisted on
 * `chat_messages`. Returns `null`s for any fields the upstream omitted (so a
 * model without timing telemetry still produces a clean row).
 */
export function summarizeFinalFrame(frame: OllamaFinalFrame): OllamaTelemetry {
  const tokensIn = numOrNull(frame.prompt_eval_count);
  const tokensOut = numOrNull(frame.eval_count);
  const evalDurationNs = numOrNull(frame.eval_duration);
  let tps: number | null = null;
  if (tokensOut !== null && tokensOut > 0 && evalDurationNs !== null && evalDurationNs > 0) {
    tps = tokensOut / (evalDurationNs / 1e9);
  }
  const totalNs = numOrNull(frame.total_duration);
  const loadNs = numOrNull(frame.load_duration);
  return {
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    tokens_per_sec: tps,
    ms_total_ollama: totalNs !== null ? totalNs / 1e6 : null,
    ms_load: loadNs !== null ? loadNs / 1e6 : null,
  };
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Async generator over NDJSON lines from a streaming Response body. Skips
 * blank lines and propagates malformed JSON as `null` so the caller can
 * decide whether to ignore or surface them. Trailing partial line (no
 * newline) is flushed at end-of-stream.
 */
export async function* iterateNdjson(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { yield JSON.parse(trimmed); } catch { yield null; }
    }
  }
  const tail = buf.trim();
  if (tail) {
    try { yield JSON.parse(tail); } catch { yield null; }
  }
}
