// Tiny client-side event bus for streaming-chat WS events.
//
// The single shared WS in AppContext owns the network; we forward chat /
// model-pull envelopes here so chat components can subscribe without
// opening a second connection. Each `dispatch*` is called from the WS
// onmessage branch when it sees a matching `type`.

type Handler<T> = (payload: T) => void;

export interface ChatChunkPayload { msgId: string; delta: string }
// Streamed chain-of-thought delta. Emitted by the server when it intercepts
// `<think>...</think>` tags on the upstream Ollama content stream (DeepSeek-R1
// / Qwen QwQ pattern). Routed to the `<Reasoning>` panel under the assistant
// message instead of the regular content stream.
export interface ChatReasoningPayload { msgId: string; delta: string }
export interface ChatStartPayload { conversationId: string; msgId: string; model: string }
export interface ChatDoneStats {
  tokens_in: number | null;
  tokens_out: number | null;
  ms_to_first_token: number | null;
  ms_total: number | null;
  tokens_per_sec: number | null;
  model: string | null;
  /** Time Ollama spent loading the model into VRAM for this turn (ms).
   *  Nonzero on cold loads; near-zero / null when the model was already
   *  resident. Surfaced in the per-message TelemetryFooter as "loaded in 4.2s". */
  load_duration_ms: number | null;
}
export interface ChatDonePayload { msgId: string; stats: ChatDoneStats }
export interface ChatErrorPayload { msgId: string; error: string }
// Surfaced while the assistant is "warming up" — currently emitted by the
// server when no token has arrived after a short delay (cold-load hint).
// `code` is the canonical tag the UI maps to a localized string;
// `message` is kept for backwards-compat with anything still emitting a
// literal. New emit sites should set `code` and leave `message` empty.
export type ChatStatusCode = 'loading_model' | 'compacting' | 'freeing_gpu' | 'unknown';
export interface ChatStatusPayload {
  msgId: string;
  code?: ChatStatusCode;
  message?: string;
}
// Best-effort auto-title broadcast after the first assistant turn finishes.
// Sidebar listens to update its row without refetching the conversation list.
export interface ChatTitlePayload { conversationId: string; title: string }

// Tool-invocation envelope emitted whenever the LLM calls a configured tool
// (web_search / rag_search / generate_image / ...). The shape mirrors the
// persisted `parts` entry on `chat_messages` so the UI can append the
// streamed live part directly to the assistant message in flight.
export interface ChatToolPart {
  type: 'tool-invocation';
  toolCallId: string;
  toolName: string;
  args: unknown;
  state: 'result' | 'error';
  result?: unknown;
  errorMessage?: string;
}
export interface ChatToolPayload { msgId: string; part: ChatToolPart }

export interface ChatCompactedPayload { conversationId: string }

export interface ChatSuggestionsPayload {
  conversationId: string;
  msgId: string;
  suggestions: string[];
}

export interface ModelPullProgressPayload {
  name: string;
  taskId: string;
  status?: string;
  digest?: string;
  total?: number;
  completed?: number;
  percent: number;
}
export interface ModelPullDonePayload { name: string; taskId: string }
export interface ModelPullErrorPayload { name: string; taskId: string; error: string }

/**
 * Gallery-added envelope re-emitted onto this bus from the page-level WS
 * handler. The chat UI subscribes (filtered by `promptId`) to swap a pending
 * `generate_image` tool result over to a rendered image when ComfyUI
 * finishes the run. We don't carry the full GalleryItem shape here — the
 * subscriber only needs the promptId + best-effort thumbnail/url so the
 * component can render an `<img>` without a separate /api lookup.
 */
export interface GalleryAddedItem {
  id: string;
  promptId: string;
  url: string;
  filename: string;
  mediaType: string;
  thumbnailUrl?: string;
}
export interface GalleryAddedPayload { items: GalleryAddedItem[] }

interface Bus {
  start: Set<Handler<ChatStartPayload>>;
  chunk: Set<Handler<ChatChunkPayload>>;
  reasoning: Set<Handler<ChatReasoningPayload>>;
  done: Set<Handler<ChatDonePayload>>;
  error: Set<Handler<ChatErrorPayload>>;
  status: Set<Handler<ChatStatusPayload>>;
  title: Set<Handler<ChatTitlePayload>>;
  tool: Set<Handler<ChatToolPayload>>;
  galleryAdded: Set<Handler<GalleryAddedPayload>>;
  pullProgress: Set<Handler<ModelPullProgressPayload>>;
  pullDone: Set<Handler<ModelPullDonePayload>>;
  pullError: Set<Handler<ModelPullErrorPayload>>;
  compacted: Set<Handler<ChatCompactedPayload>>;
  suggestions: Set<Handler<ChatSuggestionsPayload>>;
}

const bus: Bus = {
  start: new Set(), chunk: new Set(), reasoning: new Set(),
  done: new Set(), error: new Set(),
  status: new Set(), title: new Set(), tool: new Set(),
  galleryAdded: new Set(),
  pullProgress: new Set(), pullDone: new Set(), pullError: new Set(),
  compacted: new Set(),
  suggestions: new Set(),
};

function subscribe<T>(set: Set<Handler<T>>, h: Handler<T>): () => void {
  set.add(h);
  return () => { set.delete(h); };
}

export const chatEvents = {
  onStart: (h: Handler<ChatStartPayload>) => subscribe(bus.start, h),
  onChunk: (h: Handler<ChatChunkPayload>) => subscribe(bus.chunk, h),
  onReasoning: (h: Handler<ChatReasoningPayload>) => subscribe(bus.reasoning, h),
  onDone: (h: Handler<ChatDonePayload>) => subscribe(bus.done, h),
  onError: (h: Handler<ChatErrorPayload>) => subscribe(bus.error, h),
  onStatus: (h: Handler<ChatStatusPayload>) => subscribe(bus.status, h),
  onTitle: (h: Handler<ChatTitlePayload>) => subscribe(bus.title, h),
  onTool: (h: Handler<ChatToolPayload>) => subscribe(bus.tool, h),
  onGalleryAdded: (h: Handler<GalleryAddedPayload>) => subscribe(bus.galleryAdded, h),
  onPullProgress: (h: Handler<ModelPullProgressPayload>) => subscribe(bus.pullProgress, h),
  onPullDone: (h: Handler<ModelPullDonePayload>) => subscribe(bus.pullDone, h),
  onPullError: (h: Handler<ModelPullErrorPayload>) => subscribe(bus.pullError, h),
  onCompacted: (h: Handler<ChatCompactedPayload>) => subscribe(bus.compacted, h),
  onSuggestions: (h: Handler<ChatSuggestionsPayload>) => subscribe(bus.suggestions, h),

  dispatchStart: (p: ChatStartPayload) => bus.start.forEach(h => { h(p); }),
  dispatchChunk: (p: ChatChunkPayload) => bus.chunk.forEach(h => { h(p); }),
  dispatchReasoning: (p: ChatReasoningPayload) => bus.reasoning.forEach(h => { h(p); }),
  dispatchDone: (p: ChatDonePayload) => bus.done.forEach(h => { h(p); }),
  dispatchError: (p: ChatErrorPayload) => bus.error.forEach(h => { h(p); }),
  dispatchStatus: (p: ChatStatusPayload) => bus.status.forEach(h => { h(p); }),
  dispatchTitle: (p: ChatTitlePayload) => bus.title.forEach(h => { h(p); }),
  dispatchTool: (p: ChatToolPayload) => bus.tool.forEach(h => { h(p); }),
  dispatchGalleryAdded: (p: GalleryAddedPayload) => bus.galleryAdded.forEach(h => { h(p); }),
  dispatchPullProgress: (p: ModelPullProgressPayload) => bus.pullProgress.forEach(h => { h(p); }),
  dispatchPullDone: (p: ModelPullDonePayload) => bus.pullDone.forEach(h => { h(p); }),
  dispatchPullError: (p: ModelPullErrorPayload) => bus.pullError.forEach(h => { h(p); }),
  dispatchCompacted: (p: ChatCompactedPayload) => bus.compacted.forEach(h => { h(p); }),
  dispatchSuggestions: (p: ChatSuggestionsPayload) => bus.suggestions.forEach(h => { h(p); }),
};
