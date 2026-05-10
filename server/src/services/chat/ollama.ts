// Ollama HTTP API helpers: /api/chat (NDJSON), /api/ps, /api/pull, and
// the AI-SDK tool bridge. All five original files hit `${baseUrl}/api/…`
// on the local Ollama daemon and share no cheerio/HTML-scraping dependency.

import { spawn } from 'child_process';
import { asSchema } from 'ai';
import type { UIMessage } from 'ai';
import type { JSONSchema7 } from '@ai-sdk/provider';
import { stripTrailingSlash } from '../../lib/url.js';
import * as settings from '../settings/index.js';
import { emitChatEvent } from './broadcaster.js';

void spawn; // imported only to prevent tree-shaking in some bundlers

// ---------- Types: ollamaChat ----------

/** Wire shape of a single tool call echoed on an assistant message. */
export interface AssistantToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: unknown };
}

/** A native Ollama chat message — the wire shape we POST to /api/chat. */
export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Base64 image strings (no data: prefix) for multimodal models. */
  images?: string[];
  /** Echoed on tool-role messages for call→result attribution. */
  tool_call_id?: string;
  /** Tool calls the assistant requested in this turn. */
  tool_calls?: AssistantToolCall[];
}

/**
 * Final NDJSON frame fields surfaced by Ollama once `done: true`.
 * All `*_duration` values are nanoseconds.
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

// ---------- Types: ollamaTools ----------

export interface OllamaToolDef {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: JSONSchema7;
  };
}

export interface OllamaToolCall {
  function: {
    name: string;
    arguments: unknown;
  };
}

/** Per-call context threaded into `tool.execute` via `opts`. Used by MCP
 *  wrappers so tool media gets attributed to the right conversation/message. */
export interface ToolExecCtx {
  conversationId: string;
  messageId: string;
}

// ---------- Types: ollamaStep ----------

export interface OllamaStepInput {
  baseUrl: string;
  model: string;
  keepAlive: string;
  messages: OllamaChatMessage[];
  tools?: OllamaToolDef[];
  abort: AbortController;
  onChunk: (delta: string) => void;
  /** Newer Ollama (0.5+) ships chain-of-thought in a separate `thinking`
   *  field on `message` — distinct from the `<think>…</think>` inline tags
   *  older models embed in `content`. Optional — providers without `thinking`
   *  never trigger it. */
  onReasoningChunk?: (delta: string) => void;
  onFirstChunk?: () => void;
  /** Per-conversation context-window override → `options.num_ctx`. */
  numCtx?: number;
  /** `'on'` → `think: true`; `'off'` → `think: false`; undefined → omitted. */
  thinkMode?: 'on' | 'off';
  /** Sampling temperature override → `options.temperature`. */
  temperature?: number;
  /** Output format → top-level `format` field on /api/chat. */
  format?: 'json';
}

export interface OllamaStepResult {
  accumulated: string;
  finalFrame: OllamaFinalFrame | null;
  toolCalls: OllamaToolCall[];
}

// ---------- Types: ollamaPull ----------

export interface StartPullResult {
  taskId: string;
  alreadyActive: boolean;
}

// ---------- ollamaChat helpers ----------

/**
 * Project a UIMessage[] (AI SDK) into Ollama's native message wire shape.
 * Only the LATEST user message keeps its images — prior-turn images are
 * stripped because each base64 attachment burns 1-2K tokens of context.
 */
export function convertToOllamaMessages(
  messages: UIMessage[],
  systemPrompt: string | null,
): OllamaChatMessage[] {
  const out: OllamaChatMessage[] = [];
  if (systemPrompt && systemPrompt.length > 0) {
    out.push({ role: 'system', content: systemPrompt });
  }
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
        // Fold reasoning into content so the dialog stays coherent on follow-up turns.
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

export function extractBase64FromDataUrl(url: string): string | null {
  const m = /^data:[^;]+;base64,(.+)$/.exec(url);
  if (!m) return null;
  return m[1];
}

/**
 * Reduce Ollama's final NDJSON frame to the telemetry columns persisted on
 * `chat_messages`. Returns nulls for any fields the upstream omitted.
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
 * Async generator over NDJSON lines from a streaming Response body.
 * Skips blank lines; propagates malformed JSON as `null`. Trailing partial
 * line (no newline) is flushed at end-of-stream.
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

// ---------- ollamaTools helpers ----------

interface AiSdkTool {
  description?: string;
  inputSchema?: unknown;
  execute?: (input: unknown, opts: unknown) => Promise<unknown> | unknown;
}

function isToolLike(value: unknown): value is AiSdkTool {
  return value !== null && typeof value === 'object'
    && 'inputSchema' in (value as Record<string, unknown>);
}

/**
 * Convert the AI SDK `tool()` descriptor map into Ollama's tool array.
 * `inputSchema` is a Zod / Standard / JSON-Schema object; `asSchema` normalizes
 * any of those into a `Schema<T>` whose `jsonSchema` we hand to Ollama.
 */
export async function toOllamaTools(
  tools: Record<string, unknown>,
): Promise<OllamaToolDef[]> {
  const out: OllamaToolDef[] = [];
  for (const [name, raw] of Object.entries(tools)) {
    if (!isToolLike(raw)) continue;
    const schema = asSchema(raw.inputSchema as never);
    const json = await schema.jsonSchema as JSONSchema7;
    out.push({
      type: 'function',
      function: {
        name,
        description: typeof raw.description === 'string' ? raw.description : undefined,
        parameters: json,
      },
    });
  }
  return out;
}

/**
 * gpt-oss / Harmony models occasionally append channel markers like
 * `<|channel|>commentary` or `<|return|>` to the tool-call function name.
 * Strip everything from the first `<|` onward so name lookup matches the
 * registered tool.
 */
function sanitizeToolCallName(name: string): string {
  const i = name.indexOf('<|');
  const cleaned = i >= 0 ? name.slice(0, i) : name;
  return cleaned.trim();
}

/** Best-effort extraction of `tool_calls` from a streamed Ollama frame. */
export function extractToolCalls(frame: unknown): OllamaToolCall[] {
  if (!frame || typeof frame !== 'object') return [];
  const message = (frame as { message?: unknown }).message;
  if (!message || typeof message !== 'object') return [];
  const calls = (message as { tool_calls?: unknown }).tool_calls;
  if (!Array.isArray(calls)) return [];
  const out: OllamaToolCall[] = [];
  for (const c of calls) {
    if (!c || typeof c !== 'object') continue;
    const fn = (c as { function?: unknown }).function;
    if (!fn || typeof fn !== 'object') continue;
    const rawName = (fn as { name?: unknown }).name;
    if (typeof rawName !== 'string' || rawName.length === 0) continue;
    const name = sanitizeToolCallName(rawName);
    if (name.length === 0) continue;
    const args = (fn as { arguments?: unknown }).arguments;
    out.push({ function: { name, arguments: args } });
  }
  return out;
}

/**
 * Execute a single tool call against the AI-SDK tool descriptor. Catches every
 * failure and returns it as a structured payload — tool errors must NEVER
 * bubble as exceptions because that aborts the streaming run.
 */
export async function executeOllamaToolCall(
  tools: Record<string, unknown>,
  call: OllamaToolCall,
  callId: string,
  ctx: ToolExecCtx,
): Promise<{ ok: true; output: unknown } | { ok: false; error: string }> {
  const t = tools[call.function.name];
  if (!isToolLike(t) || typeof t.execute !== 'function') {
    return { ok: false, error: `unknown tool "${call.function.name}"` };
  }
  // Ollama may serialize `arguments` as a parsed object or as a JSON string.
  let input: unknown = call.function.arguments;
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch { /* leave as-is */ }
  }
  try {
    const output = await t.execute(input, {
      toolCallId: callId,
      messages: [],
      conversationId: ctx.conversationId,
      messageId: ctx.messageId,
    });
    return { ok: true, output };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------- ollamaStep ----------

/**
 * One Ollama /api/chat round-trip with optional tools. Handles streaming +
 * NDJSON parsing + token accumulation. Returns the final frame, accumulated
 * text, and any tool_calls the model emitted.
 */
export async function runOllamaStep(input: OllamaStepInput): Promise<OllamaStepResult> {
  const body: Record<string, unknown> = {
    model: input.model,
    messages: input.messages,
    stream: true,
    keep_alive: input.keepAlive,
  };
  if (input.tools && input.tools.length > 0) body.tools = input.tools;
  if (input.numCtx && input.numCtx > 0) {
    body.options = { ...(body.options as object | undefined), num_ctx: input.numCtx };
  }
  if (typeof input.temperature === 'number' && Number.isFinite(input.temperature)) {
    body.options = { ...(body.options as object | undefined), temperature: input.temperature };
  }
  if (input.thinkMode === 'on') body.think = true;
  else if (input.thinkMode === 'off') body.think = false;
  if (input.format === 'json') body.format = 'json';

  const res = await fetch(`${stripTrailingSlash(input.baseUrl)}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: input.abort.signal,
  });
  if (!res.ok || !res.body) {
    let detail = '';
    try { detail = await res.text(); } catch { /* ignore */ }
    throw new Error(
      `ollama /api/chat ${res.status} ${res.statusText}`
      + (detail ? ': ' + detail.slice(0, 240) : ''),
    );
  }

  let firstChunkSeen = false;
  let accumulated = '';
  let finalFrame: OllamaFinalFrame | null = null;
  let toolCalls: OllamaToolCall[] = [];

  for await (const obj of iterateNdjson(res.body)) {
    if (!obj || typeof obj !== 'object') continue;
    const frame = obj as Record<string, unknown> & OllamaFinalFrame;
    if (typeof frame.error === 'string') throw new Error(frame.error);
    const message = frame.message as { content?: string; thinking?: string } | undefined;
    const delta = typeof message?.content === 'string' ? message.content : '';
    const thinkingDelta = typeof message?.thinking === 'string' ? message.thinking : '';
    if (thinkingDelta.length > 0) {
      // Reasoning deltas count as first activity — they arrive before visible
      // content on thinking-mode models, so without this the loading hint
      // would stay up the whole time the model is reasoning.
      if (!firstChunkSeen) {
        firstChunkSeen = true;
        if (input.onFirstChunk) input.onFirstChunk();
      }
      input.onReasoningChunk?.(thinkingDelta);
    }
    if (delta.length > 0) {
      if (!firstChunkSeen) {
        firstChunkSeen = true;
        if (input.onFirstChunk) input.onFirstChunk();
      }
      accumulated += delta;
      input.onChunk(delta);
    }
    // Ollama streams tool_calls on a `done: false` frame *before* the closing
    // telemetry frame. Pull from every frame; the last non-empty wins.
    const calls = extractToolCalls(frame);
    if (calls.length > 0) toolCalls = calls;
    if (frame.done === true) {
      finalFrame = frame;
      break;
    }
  }

  return { accumulated, finalFrame, toolCalls };
}

// ---------- ollamaPs ----------

const PS_TIMEOUT_MS = 500;

interface PsModelEntry {
  name?: string;
  model?: string;
  context_length?: number;
}
interface PsResponse {
  models?: PsModelEntry[];
}

async function fetchPs(baseUrl: string): Promise<PsResponse | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PS_TIMEOUT_MS);
  try {
    const res = await fetch(`${stripTrailingSlash(baseUrl)}/api/ps`, {
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return await res.json() as PsResponse;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function findModel(body: PsResponse | null, model: string): PsModelEntry | null {
  if (!body || !Array.isArray(body.models)) return null;
  return body.models.find((m) => m?.name === model || m?.model === model) ?? null;
}

/**
 * Returns true if `model` is currently loaded in Ollama's VRAM, false if
 * not loaded, null when /api/ps is unreachable.
 */
export async function isModelLoaded(
  baseUrl: string, model: string,
): Promise<boolean | null> {
  if (!model) return null;
  const body = await fetchPs(baseUrl);
  if (body === null) return null;
  return findModel(body, model) !== null;
}

/**
 * Returns the actual `num_ctx` Ollama allocated for `model` on its current
 * load. `null` when the model isn't loaded yet, /api/ps is unreachable, or
 * the field is missing from the response. Caller should treat null as
 * "we don't know yet".
 */
export async function getLoadedContextLength(
  baseUrl: string, model: string,
): Promise<number | null> {
  if (!model) return null;
  const body = await fetchPs(baseUrl);
  const entry = findModel(body, model);
  if (!entry) return null;
  const n = entry.context_length;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

// ---------- ollamaPull ----------

interface ActivePull { taskId: string; abort: AbortController }

const active = new Map<string, ActivePull>();

function makePullId(): string {
  return 'pull_' + Math.random().toString(36).slice(2, 12);
}

export function startPull(name: string): StartPullResult {
  const existing = active.get(name);
  if (existing) return { taskId: existing.taskId, alreadyActive: true };
  const taskId = makePullId();
  const abort = new AbortController();
  active.set(name, { taskId, abort });
  void runPull(name, taskId, abort).finally(() => active.delete(name));
  return { taskId, alreadyActive: false };
}

async function runPull(name: string, taskId: string, abort: AbortController): Promise<void> {
  const baseUrl = settings.getOllamaUrl();
  emitChatEvent({
    type: 'model:pull:progress',
    data: { name, taskId, percent: 0, status: 'starting' },
  });
  try {
    const res = await fetch(`${baseUrl}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, stream: true }),
      signal: abort.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`upstream ${res.status} ${res.statusText}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let lastErr: string | null = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed) as Record<string, unknown>;
          if (typeof obj.error === 'string') { lastErr = obj.error; continue; }
          const status = typeof obj.status === 'string' ? obj.status : '';
          const total = typeof obj.total === 'number' ? obj.total : undefined;
          const completed = typeof obj.completed === 'number' ? obj.completed : undefined;
          const digest = typeof obj.digest === 'string' ? obj.digest : undefined;
          let percent = 0;
          if (total && total > 0 && completed !== undefined) {
            percent = Math.min(100, Math.round((completed / total) * 100));
          } else if (status === 'success') {
            percent = 100;
          }
          emitChatEvent({
            type: 'model:pull:progress',
            data: { name, taskId, status, digest, total, completed, percent },
          });
        } catch { /* malformed NDJSON line — skip */ }
      }
    }
    if (lastErr) throw new Error(lastErr);
    emitChatEvent({ type: 'model:pull:done', data: { name, taskId } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitChatEvent({ type: 'model:pull:error', data: { name, taskId, error: message } });
  }
}

export function cancelPull(name: string): boolean {
  const entry = active.get(name);
  if (!entry) return false;
  entry.abort.abort();
  active.delete(name);
  return true;
}
