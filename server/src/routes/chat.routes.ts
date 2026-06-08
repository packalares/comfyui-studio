// Conversation CRUD, streaming kickoff, and per-conversation SSE stream.
//
// POST /chat/start           — kick off streaming; returns {conversationId,msgId}.
// POST /chat/stop/:msgId     — abort an in-flight stream.
// GET  /chat/conversations   — paginated list (page/pageSize).
// GET  /chat/conversations/:id            — single conv + optional usage.
// GET  /chat/conversations/:id/messages   — cursor-paginated messages.
// GET  /chat/conversations/:id/stream     — SSE: chunk/reasoning/tool/done/error.
// GET  /chat/conversations/:id/usage      — context-window meter state.
// POST /chat/conversations/:id/compact    — manual summarization.
// PATCH /chat/conversations/:id           — rename/patch settings.
// DELETE /chat/conversations             — wipe all.
// DELETE /chat/conversations/:id         — delete one.
// DELETE /chat/conversations/:id/messages/:msgId — delete one message.

import { Router } from 'express';
import { z } from 'zod';
import type { UIMessage } from 'ai';
import * as chatRepo from '../lib/db/chat.repo.js';
import * as chatContextRepo from '../lib/db/chat.context.repo.js';
import * as settings from '../services/settings/index.js';
import { startStream, abortStream } from '../services/chat/streamChat.js';
import { subscribeToConvStream } from '../services/chat/convSubscriber.js';
import { resolveSystemPrompt } from '../services/chat/personality.js';
import { computeUsage } from '../services/chat/contextWindow.js';
import { compactConversation } from '../services/chat/contextCompact.js';
import {
  deleteAllAttachmentFiles,
  deleteConversationAttachmentFiles,
  deleteMessageAttachmentFiles,
  hydrateParts,
  buildAttachmentMap,
} from '../services/chat/attachments.js';
import { defineRoute } from '../lib/defineRoute.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { openSseStream } from '../lib/sse.js';
import { logger } from '../lib/logger.js';
import {
  ConversationDetailSchema,
  ListConversationsQuerySchema,
  ListConversationsOutputSchema,
  ChatStartBodySchema,
  ChatStartOutputSchema,
  StopStreamOutputSchema,
  MessagesPageOutputSchema,
  PatchConversationBodySchema,
  DeleteConversationOutputSchema,
  DeleteAllConversationsOutputSchema,
  DeleteMessageOutputSchema,
  CompactOutputSchema,
  ChatUsageStateSchema,
  chatConvSseSpec,
} from '../contracts/chat.contract.js';
import { paginate, splitPaginated } from '../lib/pagination.js';

const router = Router();

function makeId(): string {
  return Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
}

function deriveTitle(messages: UIMessage[]): string {
  const firstUser = messages.find(m => m.role === 'user');
  if (!firstUser) return 'New chat';
  const txt = (firstUser.parts ?? [])
    .map(p => (p && (p as { type?: string }).type === 'text'
      ? String((p as { text?: string }).text ?? '')
      : ''))
    .join(' ')
    .trim();
  if (!txt) return 'New chat';
  return txt.length > 60 ? txt.slice(0, 57) + '...' : txt;
}

// ---- POST /chat/start ----

const startRoute = defineRoute(
  {
    method: 'POST',
    path: '/chat/start',
    body: ChatStartBodySchema,
    response: ChatStartOutputSchema,
    auth: { required: true, scopes: ['chat:write'] },
    tags: ['chat'],
    summary: 'Kick off a streaming chat turn',
  },
  (ctx) => {
    const body = ctx.body;
    const messages = body.messages as UIMessage[];
    const requestedModel = (body.model?.trim() ?? '') || settings.getChatDefaultModel();
    if (!requestedModel) {
      throw new ValidationError('model is required (no default chat model is configured)');
    }
    const soulName = body.soulName ?? null;
    const enabledToolFilter = body.enabledTools ?? null;

    let conversationId = body.conversationId?.trim() ?? '';
    let resolvedSystemPrompt: string | null;

    if (conversationId) {
      const existing = chatRepo.getConversation(conversationId);
      if (!existing) throw new NotFoundError('conversation not found');
      resolvedSystemPrompt = resolveSystemPrompt(existing.soul_name) || null;
    } else {
      conversationId = makeId();
      const now = Date.now();
      resolvedSystemPrompt = resolveSystemPrompt(soulName) || null;
      const defaultThink = settings.getChatDefaultThinkMode();
      const initStrategy = body.initialContextStrategy ?? settings.getDefaultContextStrategy();
      const initThink: 'on' | 'off' | null = body.initialThinkMode === 'on' || body.initialThinkMode === 'off'
        ? body.initialThinkMode
        : (defaultThink === 'auto' ? null : defaultThink);
      const initNumCtx = typeof body.initialNumCtx === 'number' && Number.isFinite(body.initialNumCtx)
        ? Math.max(1, Math.floor(body.initialNumCtx))
        : null;
      const initTemp = typeof body.initialTemperature === 'number' && Number.isFinite(body.initialTemperature)
        ? Math.max(0, Math.min(2, body.initialTemperature))
        : null;
      const initFormat: 'json' | null = body.initialFormat === 'json' ? 'json' : null;
      chatRepo.createConversation({
        id: conversationId,
        title: deriveTitle(messages),
        model: requestedModel,
        soul_name: soulName,
        created_at: now,
        updated_at: now,
        context_strategy: initStrategy,
        think_mode: initThink,
        num_ctx: initNumCtx,
        temperature: initTemp,
        format: initFormat,
      });
    }

    const { msgId } = startStream({
      conversationId,
      messages,
      model: requestedModel,
      systemPrompt: resolvedSystemPrompt,
      keepAlive: settings.getChatKeepAlive(),
      enabledToolFilter,
    });
    return ctx.ok({ conversationId, msgId });
  },
);

// ---- POST /chat/stop/:msgId ----

const stopRoute = defineRoute(
  {
    method: 'POST',
    path: '/chat/stop/:msgId',
    params: z.object({ msgId: z.string() }),
    response: StopStreamOutputSchema,
    auth: { required: true, scopes: ['chat:write'] },
    tags: ['chat'],
    summary: 'Abort an in-flight chat stream',
  },
  (ctx) => {
    const aborted = abortStream(ctx.params.msgId);
    return ctx.ok({ aborted });
  },
);

// ---- GET /chat/conversations ----
// Accepts page/pageSize (standardised). Legacy limit/offset still work but
// are silently remapped so old callers don't break while Wave 4 clients
// switch to page/pageSize.

const listConvsRoute = defineRoute(
  {
    method: 'GET',
    path: '/chat/conversations',
    query: z.object({
      // page/pageSize — preferred
      page: z.coerce.number().int().min(1).optional(),
      pageSize: z.coerce.number().int().min(1).max(100).optional(),
      // legacy limit/offset — mapped internally
      limit: z.coerce.number().int().min(1).max(100).optional(),
      offset: z.coerce.number().int().min(0).optional(),
      q: z.string().optional(),
    }),
    response: ListConversationsOutputSchema,
    auth: { required: false, scopes: ['chat:read'] },
    tags: ['chat'],
    summary: 'List conversations (paginated)',
  },
  (ctx) => {
    const q = ctx.query;
    // Resolve page/pageSize, falling back to legacy limit/offset.
    const pageSize = q.pageSize ?? q.limit ?? 20;
    const page = q.page ?? (q.offset !== undefined ? Math.floor(q.offset / pageSize) + 1 : 1);
    const offset = (page - 1) * pageSize;

    const result = chatRepo.listConversations({
      limit: pageSize,
      offset,
      search: q.q,
    });

    const envelope = paginate(result.items, page, pageSize);
    const { items, meta } = splitPaginated(envelope);
    // Override total with the DB total (paginate() computes from slice length)
    return ctx.ok(items, { ...meta, total: result.total });
  },
);

// ---- GET /chat/conversations/:id ----

const getConvRoute = defineRoute(
  {
    method: 'GET',
    path: '/chat/conversations/:id',
    params: z.object({ id: z.string() }),
    query: z.object({ model: z.string().optional() }),
    response: ConversationDetailSchema,
    auth: { required: false, scopes: ['chat:read'] },
    tags: ['chat'],
    summary: 'Get a single conversation',
  },
  async (ctx) => {
    const row = chatRepo.getConversation(ctx.params.id);
    if (!row) throw new NotFoundError();
    const model = ctx.query.model?.trim() || row.model || '';
    let usage = null;
    if (model) {
      try { usage = await computeUsage({ conversationId: ctx.params.id, model }); }
      catch { /* meter degrades gracefully */ }
    }
    return ctx.ok({ ...row, usage });
  },
);

// ---- GET /chat/conversations/:id/messages ----

const getMessagesRoute = defineRoute(
  {
    method: 'GET',
    path: '/chat/conversations/:id/messages',
    params: z.object({ id: z.string() }),
    query: z.object({
      limit: z.coerce.number().int().min(1).max(200).optional(),
      before: z.string().min(1).optional(),
    }),
    response: MessagesPageOutputSchema,
    auth: { required: false, scopes: ['chat:read'] },
    tags: ['chat'],
    summary: 'Cursor-paginated message list',
  },
  (ctx) => {
    const conv = chatRepo.getConversation(ctx.params.id);
    if (!conv) throw new NotFoundError();

    const limit = ctx.query.limit ?? 50;
    const before = ctx.query.before?.trim() || undefined;

    const { items: messages, hasMore, oldestId } = chatRepo.listMessagesPage(ctx.params.id, {
      limit,
      before,
    });

    const byMsg = chatRepo.listAttachmentsForMessages(messages.map(m => m.id));
    const rows = messages.map((m) => {
      let parts: unknown = [];
      try { parts = JSON.parse(m.parts); } catch { parts = []; }
      const attachments = byMsg.get(m.id) ?? [];
      if (attachments.length > 0) {
        parts = hydrateParts(parts, buildAttachmentMap(attachments));
      }
      return {
        id: m.id,
        conversationId: m.conversation_id,
        role: m.role,
        parts: parts as Record<string, unknown>[],
        tokens_in: m.tokens_in,
        tokens_out: m.tokens_out,
        ms_to_first_token: m.ms_to_first_token,
        ms_total: m.ms_total,
        tokens_per_sec: m.tokens_per_sec,
        load_duration_ms: m.load_duration_ms,
        model: m.model,
        created_at: m.created_at,
      };
    });
    return ctx.ok({ items: rows, hasMore, oldestId });
  },
);

// ---- DELETE /chat/conversations ----
// Must be declared BEFORE /:id so Express doesn't eat "conversations" as a param.

const deleteAllConvsRoute = defineRoute(
  {
    method: 'DELETE',
    path: '/chat/conversations',
    response: DeleteAllConversationsOutputSchema,
    auth: { required: false, scopes: ['chat:write'] },
    tags: ['chat'],
    summary: 'Wipe all conversations',
  },
  (_ctx) => {
    try { deleteAllAttachmentFiles(); }
    catch (err) { logger.warn('bulk delete: attachment cleanup failed', { error: String(err) }); }
    const deleted = chatRepo.deleteAllConversations();
    return _ctx.ok({ deleted });
  },
);

// ---- DELETE /chat/conversations/:id ----

const deleteConvRoute = defineRoute(
  {
    method: 'DELETE',
    path: '/chat/conversations/:id',
    params: z.object({ id: z.string() }),
    response: DeleteConversationOutputSchema,
    auth: { required: false, scopes: ['chat:write'] },
    tags: ['chat'],
    summary: 'Delete a conversation',
  },
  (ctx) => {
    const { id } = ctx.params;
    try { deleteConversationAttachmentFiles(id); }
    catch (err) { logger.warn('conversation delete: attachment cleanup failed', { id, error: String(err) }); }
    const ok = chatRepo.deleteConversation(id);
    if (!ok) throw new NotFoundError();
    return ctx.ok({ deleted: true, id });
  },
);

// ---- DELETE /chat/conversations/:id/messages/:msgId ----

const deleteMessageRoute = defineRoute(
  {
    method: 'DELETE',
    path: '/chat/conversations/:id/messages/:msgId',
    params: z.object({ id: z.string(), msgId: z.string() }),
    response: DeleteMessageOutputSchema,
    auth: { required: false, scopes: ['chat:write'] },
    tags: ['chat'],
    summary: 'Delete a single message',
  },
  (ctx) => {
    const { id, msgId } = ctx.params;
    try { deleteMessageAttachmentFiles(msgId); }
    catch (err) { logger.warn('message delete: attachment cleanup failed', { msgId, error: String(err) }); }
    const ok = chatRepo.deleteMessage(id, msgId);
    if (!ok) throw new NotFoundError();
    return ctx.ok({ deleted: true, id, msgId });
  },
);

// ---- PATCH /chat/conversations/:id ----

const patchConvRoute = defineRoute(
  {
    method: 'PATCH',
    path: '/chat/conversations/:id',
    params: z.object({ id: z.string() }),
    body: PatchConversationBodySchema,
    response: ConversationDetailSchema,
    auth: { required: false, scopes: ['chat:write'] },
    tags: ['chat'],
    summary: 'Patch conversation settings / rename',
  },
  (ctx) => {
    const { id } = ctx.params;
    const body = ctx.body;
    const patch: chatRepo.UpdateConversationPatch = {};
    if (typeof body.title === 'string') patch.title = body.title;
    if (typeof body.model === 'string') patch.model = body.model;
    if ('soul_name' in body) patch.soul_name = body.soul_name as string | null;
    if (body.num_ctx === null) {
      patch.num_ctx = null;
    } else if (typeof body.num_ctx === 'number' && Number.isFinite(body.num_ctx) && body.num_ctx > 0) {
      patch.num_ctx = Math.round(body.num_ctx);
    }
    if (body.think_mode === null) {
      patch.think_mode = null;
    } else if (body.think_mode === 'on' || body.think_mode === 'off') {
      patch.think_mode = body.think_mode;
    }
    if (body.temperature === null) {
      patch.temperature = null;
    } else if (typeof body.temperature === 'number' && Number.isFinite(body.temperature)) {
      patch.temperature = Math.max(0, Math.min(2, body.temperature));
    }
    if (body.format === null) {
      patch.format = null;
    } else if (body.format === 'json') {
      patch.format = 'json';
    }
    if (typeof body.pinned === 'boolean') patch.pinned = body.pinned;

    let strategyTouched = false;
    if (chatRepo.isContextStrategy(body.context_strategy)) {
      chatContextRepo.setStrategy(id, body.context_strategy);
      strategyTouched = true;
    }

    let ok = false;
    if (Object.keys(patch).length > 0) {
      ok = chatRepo.renameConversation(id, patch, Date.now());
    } else {
      ok = strategyTouched && chatRepo.getConversation(id) !== null;
    }
    if (!ok) throw new NotFoundError();
    const row = chatRepo.getConversation(id);
    if (!row) throw new NotFoundError();
    return ctx.ok({ ...row, usage: undefined });
  },
);

// ---- GET /chat/conversations/:id/usage ----

const getUsageRoute = defineRoute(
  {
    method: 'GET',
    path: '/chat/conversations/:id/usage',
    params: z.object({ id: z.string() }),
    query: z.object({
      model: z.string().optional(),
      pending: z.string().optional(),
    }),
    response: ChatUsageStateSchema,
    auth: { required: false, scopes: ['chat:read'] },
    tags: ['chat'],
    summary: 'Get context-window usage for a conversation',
  },
  async (ctx) => {
    const { id } = ctx.params;
    const conv = chatRepo.getConversation(id);
    if (!conv) throw new NotFoundError();
    const model = ctx.query.model?.trim() || conv.model;
    const usage = await computeUsage({
      conversationId: id,
      model,
      pendingUserText: ctx.query.pending,
    });
    return ctx.ok(usage);
  },
);

// ---- POST /chat/conversations/:id/compact ----

const compactRoute = defineRoute(
  {
    method: 'POST',
    path: '/chat/conversations/:id/compact',
    params: z.object({ id: z.string() }),
    response: CompactOutputSchema,
    auth: { required: false, scopes: ['chat:write'] },
    tags: ['chat'],
    summary: 'Manually compact a conversation',
  },
  async (ctx) => {
    const result = await compactConversation(ctx.params.id);
    if (!result.ok) {
      if (result.error === 'conversation not found') throw new NotFoundError();
      throw new ValidationError(result.error ?? 'compact failed');
    }
    return ctx.ok({ ok: true as const, summary: result.summary! });
  },
);

// ---- Register all defineRoute routes ----

startRoute.register(router);
stopRoute.register(router);
listConvsRoute.register(router);
getConvRoute.register(router);
getMessagesRoute.register(router);
deleteAllConvsRoute.register(router);
deleteConvRoute.register(router);
deleteMessageRoute.register(router);
patchConvRoute.register(router);
getUsageRoute.register(router);
compactRoute.register(router);

// ---- GET /chat/conversations/:id/stream — per-conversation SSE ----
//
// Streams chunk/reasoning/tool/done/error events for the active message in
// the given conversation. Taps the global emitChatEvent bus (the same one
// the WS broadcaster consumes) and filters by msgId; both paths stay live.
//
// This endpoint is intentionally hand-rolled (not via defineRoute) because
// it holds an open SSE connection — the defineRoute wrapper expects a single
// JSON response and would close the request before the first event.

router.get('/chat/conversations/:id/stream', (req, res) => {
  const convId = String(req.params.id ?? '');
  if (!convId) {
    res.status(400).json({ error: { code: 'validation_failed', message: 'id is required' } });
    return;
  }

  const stream = openSseStream(req, res, chatConvSseSpec, {
    onClose: () => unsub(),
  });

  const unsub = subscribeToConvStream(convId, {
    onChunk: (p) => { void stream.emit('chunk', p); },
    onReasoning: (p) => { void stream.emit('reasoning', p); },
    onTool: (p) => { void stream.emit('tool', p); },
    onStatus: (p) => { void stream.emit('status', p); },
    onDone: (p) => { void stream.emitTerminal('done', p); },
    onError: (p) => { void stream.emitTerminal('error', p); },
  });
});

export default router;
