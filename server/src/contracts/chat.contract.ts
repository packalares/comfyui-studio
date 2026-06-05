// Canonical Zod schemas + route specs for the chat domain.
//
// Imported by chat.routes.ts (server), ui/src/api/chat.ts (UI), and
// the Wave 4 OpenAPI emitter. All runtime types are derived via z.infer.
// The exported `chatRoutes.*` spec objects are consumed by `apiCall()` in the
// UI client — they carry just enough metadata (method, path, schemas) so the
// client can build typed requests without importing any handler code.

import { z } from 'zod';
import { defineSseRouteSpec } from './sse.contract.js';
import type { RouteSpec } from '../lib/defineRoute.js';

// ---- Conversation ----

export const ContextStrategySchema = z.enum(['sliding', 'auto']);

export const ConversationSchema = z.object({
  id: z.string(),
  title: z.string(),
  model: z.string(),
  soul_name: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
  context_strategy: ContextStrategySchema,
  num_ctx: z.number().nullable(),
  think_mode: z.enum(['on', 'off']).nullable(),
  temperature: z.number().nullable(),
  format: z.literal('json').nullable(),
  pinned: z.boolean(),
});
export type Conversation = z.infer<typeof ConversationSchema>;

// ---- List conversations ----

export const ListConversationsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  q: z.string().optional(),
});

export const ListConversationsOutputSchema = z.array(ConversationSchema);

// ---- Start stream ----

export const ChatStartBodySchema = z.object({
  conversationId: z.string().optional(),
  model: z.string().optional(),
  messages: z.array(z.object({
    id: z.string(),
    role: z.enum(['user', 'assistant', 'system']),
    parts: z.array(z.record(z.string(), z.unknown())),
  })).min(1),
  soulName: z.string().nullable().optional(),
  enabledTools: z.array(z.string()).nullable().optional(),
  initialContextStrategy: ContextStrategySchema.optional(),
  initialThinkMode: z.enum(['on', 'off']).nullable().optional(),
  initialNumCtx: z.number().nullable().optional(),
  initialTemperature: z.number().nullable().optional(),
  initialFormat: z.literal('json').nullable().optional(),
});

export const ChatStartOutputSchema = z.object({
  conversationId: z.string(),
  msgId: z.string(),
});

// ---- Stop stream ----

export const StopStreamOutputSchema = z.object({ aborted: z.boolean() });

// ---- Conversation detail (with optional usage) ----

export const ChatUsageStateSchema = z.object({
  used: z.number(),
  budget: z.number().nullable(),
  percent: z.number(),
  estimatedNext: z.number(),
  warning: z.enum(['green', 'yellow', 'red']),
  strategy: ContextStrategySchema,
  model: z.string(),
  modelMaxCtx: z.number().nullable(),
  numCtx: z.number().nullable(),
  thinkMode: z.enum(['on', 'off']).nullable(),
  temperature: z.number().nullable(),
  format: z.literal('json').nullable(),
});

export const ConversationDetailSchema = ConversationSchema.extend({
  usage: ChatUsageStateSchema.nullable().optional(),
});

// ---- Messages list ----

// Parts are opaque at the contract level — callers narrow to ChatUIMessagePart
// as needed. Using z.unknown() avoids breaking the existing UI type hierarchy.
export const MessagePartSchema = z.unknown();

export const ChatMessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  role: z.enum(['user', 'assistant', 'system']),
  parts: z.array(MessagePartSchema),
  tokens_in: z.number().nullable(),
  tokens_out: z.number().nullable(),
  ms_to_first_token: z.number().nullable(),
  ms_total: z.number().nullable(),
  tokens_per_sec: z.number().nullable(),
  load_duration_ms: z.number().nullable(),
  model: z.string().nullable(),
  created_at: z.number(),
});

export const MessagesPageOutputSchema = z.object({
  items: z.array(ChatMessageSchema),
  hasMore: z.boolean(),
  oldestId: z.string().nullable(),
});

// ---- Patch conversation ----

export const PatchConversationBodySchema = z.object({
  title: z.string().optional(),
  model: z.string().optional(),
  soul_name: z.string().nullable().optional(),
  context_strategy: ContextStrategySchema.optional(),
  num_ctx: z.number().nullable().optional(),
  think_mode: z.enum(['on', 'off']).nullable().optional(),
  temperature: z.number().nullable().optional(),
  format: z.literal('json').nullable().optional(),
  pinned: z.boolean().optional(),
}).partial();

// ---- Delete results ----

export const DeleteConversationOutputSchema = z.object({
  deleted: z.boolean(),
  id: z.string(),
});

export const DeleteAllConversationsOutputSchema = z.object({ deleted: z.number() });

export const DeleteMessageOutputSchema = z.object({
  deleted: z.boolean(),
  id: z.string(),
  msgId: z.string(),
});

// ---- Compact ----

export const CompactOutputSchema = z.object({
  ok: z.literal(true),
  summary: z.string(),
});

// ---- SSE: per-conversation streaming ----
//
// Wire format for GET /api/chat/conversations/:id/stream.
// The stream emits these events until a terminal event closes it.

export const ChatDoneStatsSchema = z.object({
  tokens_in: z.number().nullable(),
  tokens_out: z.number().nullable(),
  ms_to_first_token: z.number().nullable(),
  ms_total: z.number().nullable(),
  tokens_per_sec: z.number().nullable(),
  model: z.string().nullable(),
  load_duration_ms: z.number().nullable(),
});

export const ChatToolPartSchema = z.object({
  type: z.literal('tool-invocation'),
  toolCallId: z.string(),
  toolName: z.string(),
  args: z.unknown(),
  state: z.enum(['result', 'error']),
  result: z.unknown().optional(),
  errorMessage: z.string().optional(),
});

export const chatConvSseSpec = defineSseRouteSpec({
  events: {
    /** A text delta from the LLM. */
    chunk: z.object({ msgId: z.string(), delta: z.string() }),
    /** A chain-of-thought reasoning delta (DeepSeek-R1 / Qwen QwQ). */
    reasoning: z.object({ msgId: z.string(), delta: z.string() }),
    /** A tool call completed by the LLM. */
    tool: z.object({ msgId: z.string(), part: ChatToolPartSchema }),
    /** Status hint during cold-model load. */
    status: z.object({
      msgId: z.string(),
      code: z.enum(['loading_model', 'compacting', 'freeing_gpu', 'unknown']).optional(),
      message: z.string().optional(),
    }),
    /** Stream finished — carries telemetry + refreshed context usage. */
    done: z.object({
      msgId: z.string(),
      stats: ChatDoneStatsSchema,
      usage: ChatUsageStateSchema.nullable().optional(),
    }),
    /** Stream failed (abort, upstream error, etc.). Terminal. */
    error: z.object({ msgId: z.string(), error: z.string() }),
  },
  terminalEvents: ['done', 'error'],
});

// ---- Exported route specs for UI apiCall() ----
//
// These are plain data objects (no handler logic). The UI imports them and
// passes them to apiCall(spec, input) so it gets full TypeScript coverage
// on request/response shapes without duplicating type definitions.

const convIdParam = z.object({ id: z.string() });

export const chatRoutes = {
  start: {
    method: 'POST',
    path: '/chat/start',
    body: ChatStartBodySchema,
    response: ChatStartOutputSchema,
    auth: { required: false },
    tags: ['chat'],
  } satisfies RouteSpec,

  stop: {
    method: 'POST',
    path: '/chat/stop/:msgId',
    params: z.object({ msgId: z.string() }),
    response: StopStreamOutputSchema,
    auth: { required: false },
    tags: ['chat'],
  } satisfies RouteSpec,

  listConversations: {
    method: 'GET',
    path: '/chat/conversations',
    query: z.object({
      page: z.coerce.number().int().min(1).optional(),
      pageSize: z.coerce.number().int().min(1).max(100).optional(),
      q: z.string().optional(),
    }),
    response: ListConversationsOutputSchema,
    auth: { required: false },
    tags: ['chat'],
  } satisfies RouteSpec,

  getConversation: {
    method: 'GET',
    path: '/chat/conversations/:id',
    params: convIdParam,
    query: z.object({ model: z.string().optional() }),
    response: ConversationDetailSchema,
    auth: { required: false },
    tags: ['chat'],
  } satisfies RouteSpec,

  getMessages: {
    method: 'GET',
    path: '/chat/conversations/:id/messages',
    params: convIdParam,
    query: z.object({
      limit: z.coerce.number().int().optional(),
      before: z.string().optional(),
    }),
    response: MessagesPageOutputSchema,
    auth: { required: false },
    tags: ['chat'],
  } satisfies RouteSpec,

  deleteConversation: {
    method: 'DELETE',
    path: '/chat/conversations/:id',
    params: convIdParam,
    response: DeleteConversationOutputSchema,
    auth: { required: false },
    tags: ['chat'],
  } satisfies RouteSpec,

  deleteAllConversations: {
    method: 'DELETE',
    path: '/chat/conversations',
    response: DeleteAllConversationsOutputSchema,
    auth: { required: false },
    tags: ['chat'],
  } satisfies RouteSpec,

  deleteMessage: {
    method: 'DELETE',
    path: '/chat/conversations/:id/messages/:msgId',
    params: z.object({ id: z.string(), msgId: z.string() }),
    response: DeleteMessageOutputSchema,
    auth: { required: false },
    tags: ['chat'],
  } satisfies RouteSpec,

  patchConversation: {
    method: 'PATCH',
    path: '/chat/conversations/:id',
    params: convIdParam,
    body: PatchConversationBodySchema,
    response: ConversationDetailSchema,
    auth: { required: false },
    tags: ['chat'],
  } satisfies RouteSpec,

  getUsage: {
    method: 'GET',
    path: '/chat/conversations/:id/usage',
    params: convIdParam,
    query: z.object({
      model: z.string().optional(),
      pending: z.string().optional(),
    }),
    response: ChatUsageStateSchema,
    auth: { required: false },
    tags: ['chat'],
  } satisfies RouteSpec,

  compact: {
    method: 'POST',
    path: '/chat/conversations/:id/compact',
    params: convIdParam,
    response: CompactOutputSchema,
    auth: { required: false },
    tags: ['chat'],
  } satisfies RouteSpec,
} as const;
