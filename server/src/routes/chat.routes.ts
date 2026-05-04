// Conversation CRUD + streaming kickoff.
//
// `POST /api/chat/start` returns immediately; streaming text + telemetry
// flows over the existing WS as `chat:chunk` / `chat:done` envelopes.
// Aborts go through `POST /api/chat/stop/:msgId`. All other endpoints are
// plain repo passthroughs.

import { Router, type Request, type Response } from 'express';
import type { UIMessage } from 'ai';
import * as chatRepo from '../lib/db/chat.repo.js';
import * as chatContextRepo from '../lib/db/chat.context.repo.js';
import * as settings from '../services/settings.js';
import { startStream, abortStream } from '../services/chat/streamChat.js';
import { computeUsage } from '../services/chat/contextWindow.js';
import { compactConversation } from '../services/chat/contextCompact.js';
import { listAvailableTools } from '../services/chat/tools/index.js';

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

router.post('/chat/start', (req: Request, res: Response) => {
  const body = req.body as {
    conversationId?: unknown;
    model?: unknown;
    messages?: unknown;
    systemPrompt?: unknown;
    enabledTools?: unknown;
  };
  const messages = Array.isArray(body.messages) ? body.messages as UIMessage[] : [];
  if (messages.length === 0) {
    res.status(400).json({ error: 'messages must be a non-empty array' });
    return;
  }
  const requestedModel = typeof body.model === 'string' && body.model.trim().length > 0
    ? body.model.trim()
    : settings.getChatDefaultModel();
  if (!requestedModel) {
    res.status(400).json({
      error: 'model is required (no default chat model is configured)',
    });
    return;
  }
  const systemPrompt = typeof body.systemPrompt === 'string' ? body.systemPrompt : null;
  // Optional allow-list from the composer's Tools popover. Absent / non-array
  // means "use every configured tool" (unchanged legacy behavior); an empty
  // array means "no tools this turn".
  const enabledToolFilter = Array.isArray(body.enabledTools)
    ? body.enabledTools.filter((x): x is string => typeof x === 'string')
    : null;

  let conversationId = typeof body.conversationId === 'string' && body.conversationId.length > 0
    ? body.conversationId
    : '';
  if (conversationId) {
    const existing = chatRepo.getConversation(conversationId);
    if (!existing) {
      res.status(404).json({ error: 'conversation not found' });
      return;
    }
  } else {
    conversationId = makeId();
    const now = Date.now();
    // Settings → Chat → "Default thinking mode" applies once at chat
    // creation. 'auto' leaves think_mode NULL (column-level "no override");
    // 'on' / 'off' light up the column so the user doesn't have to flip
    // the popover for every new conversation.
    const defaultThink = settings.getChatDefaultThinkMode();
    chatRepo.createConversation({
      id: conversationId,
      title: deriveTitle(messages),
      model: requestedModel,
      system_prompt: systemPrompt,
      created_at: now,
      updated_at: now,
      context_strategy: settings.getDefaultContextStrategy(),
      think_mode: defaultThink === 'auto' ? null : defaultThink,
    });
  }

  try {
    const { msgId } = startStream({
      conversationId,
      messages,
      model: requestedModel,
      systemPrompt,
      keepAlive: settings.getChatKeepAlive(),
      enabledToolFilter,
    });
    res.json({ conversationId, msgId });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

function paramStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

router.post('/chat/stop/:msgId', (req: Request, res: Response) => {
  const aborted = abortStream(paramStr(req.params.msgId));
  res.json({ aborted });
});

router.get('/chat/tools', (_req: Request, res: Response) => {
  res.json({ items: listAvailableTools() });
});

router.get('/chat/conversations', (req: Request, res: Response) => {
  // Pagination + title-search support. Defaults preserve the legacy
  // "give me everything" caller (limit=20, offset=0, no search) — clients
  // that want larger pages pass an explicit `?limit=N`.
  const limitRaw = Number.parseInt(String(req.query.limit ?? ''), 10);
  const offsetRaw = Number.parseInt(String(req.query.offset ?? ''), 10);
  const limit = Number.isFinite(limitRaw) ? limitRaw : 20;
  const offset = Number.isFinite(offsetRaw) ? offsetRaw : 0;
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  res.json(chatRepo.listConversations({ limit, offset, search: q }));
});

router.get('/chat/conversations/:id', (req: Request, res: Response) => {
  const row = chatRepo.getConversation(paramStr(req.params.id));
  if (!row) { res.status(404).json({ error: 'not found' }); return; }
  res.json(row);
});

router.get('/chat/conversations/:id/messages', (req: Request, res: Response) => {
  const id = paramStr(req.params.id);
  const conv = chatRepo.getConversation(id);
  if (!conv) { res.status(404).json({ error: 'not found' }); return; }
  const rows = chatRepo.listMessages(id).map((m) => {
    let parts: unknown = [];
    try { parts = JSON.parse(m.parts); } catch { parts = []; }
    return {
      id: m.id,
      conversationId: m.conversation_id,
      role: m.role,
      parts,
      tokens_in: m.tokens_in,
      tokens_out: m.tokens_out,
      ms_to_first_token: m.ms_to_first_token,
      ms_total: m.ms_total,
      tokens_per_sec: m.tokens_per_sec,
      model: m.model,
      created_at: m.created_at,
    };
  });
  res.json({ items: rows });
});

router.delete('/chat/conversations/:id', (req: Request, res: Response) => {
  const id = paramStr(req.params.id);
  const ok = chatRepo.deleteConversation(id);
  if (!ok) { res.status(404).json({ error: 'not found' }); return; }
  res.json({ deleted: true, id });
});

// Per-message delete used by the new in-thread Trash action. Scoped by
// conversation id so a stale ui state can't accidentally delete a message
// from a different chat. Returns 404 when nothing matched (no-op).
router.delete('/chat/conversations/:id/messages/:msgId', (req: Request, res: Response) => {
  const id = paramStr(req.params.id);
  const msgId = paramStr(req.params.msgId);
  const ok = chatRepo.deleteMessage(id, msgId);
  if (!ok) { res.status(404).json({ error: 'not found' }); return; }
  res.json({ deleted: true, id, msgId });
});

router.patch('/chat/conversations/:id', (req: Request, res: Response) => {
  const id = paramStr(req.params.id);
  const body = req.body as {
    title?: unknown;
    model?: unknown;
    system_prompt?: unknown;
    context_strategy?: unknown;
    num_ctx?: unknown;
    think_mode?: unknown;
    temperature?: unknown;
    format?: unknown;
  };
  const patch: chatRepo.UpdateConversationPatch = {};
  if (typeof body.title === 'string') patch.title = body.title;
  if (typeof body.model === 'string') patch.model = body.model;
  if (typeof body.system_prompt === 'string' || body.system_prompt === null) {
    patch.system_prompt = body.system_prompt as string | null;
  }
  // num_ctx accepts a positive integer or null. Anything else (string,
  // negative, NaN) is treated as "no patch" so a typo in the body can't
  // store junk on the row. The send path omits options.num_ctx when this
  // is null so Ollama falls back to its own default.
  if (body.num_ctx === null) {
    patch.num_ctx = null;
  } else if (typeof body.num_ctx === 'number' && Number.isFinite(body.num_ctx) && body.num_ctx > 0) {
    patch.num_ctx = Math.round(body.num_ctx);
  }
  // think_mode accepts 'on' | 'off' | null. Anything else is ignored so a
  // typo can't store junk in the column.
  if (body.think_mode === null) {
    patch.think_mode = null;
  } else if (body.think_mode === 'on' || body.think_mode === 'off') {
    patch.think_mode = body.think_mode;
  }
  // temperature: positive number or null. Clamp to a sane range so a
  // typo can't pin the chat at temperature: 999 (gibberish output).
  if (body.temperature === null) {
    patch.temperature = null;
  } else if (typeof body.temperature === 'number' && Number.isFinite(body.temperature)) {
    patch.temperature = Math.max(0, Math.min(2, body.temperature));
  }
  // format: 'json' or null only — no other modes supported by Ollama yet.
  if (body.format === null) {
    patch.format = null;
  } else if (body.format === 'json') {
    patch.format = 'json';
  }
  // Apply context_strategy as a side update — it lives on the same row but
  // outside the `renameConversation` patch helper so existing callers stay
  // unchanged. Validated against the discriminated set so a typo can't store
  // garbage in the column.
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
  if (!ok) { res.status(404).json({ error: 'not found' }); return; }
  const row = chatRepo.getConversation(id);
  res.json(row);
});

router.get('/chat/conversations/:id/usage', async (req: Request, res: Response) => {
  const id = paramStr(req.params.id);
  const conv = chatRepo.getConversation(id);
  if (!conv) { res.status(404).json({ error: 'not found' }); return; }
  const queryModel = typeof req.query.model === 'string' ? req.query.model.trim() : '';
  const queryPending = typeof req.query.pending === 'string' ? req.query.pending : '';
  const model = queryModel || conv.model;
  try {
    const usage = await computeUsage({
      conversationId: id,
      model,
      pendingUserText: queryPending,
    });
    res.json(usage);
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

router.post('/chat/conversations/:id/compact', async (req: Request, res: Response) => {
  const id = paramStr(req.params.id);
  const result = await compactConversation(id);
  if (!result.ok) {
    res.status(result.error === 'conversation not found' ? 404 : 422).json({
      error: result.error ?? 'compact failed',
    });
    return;
  }
  res.json({ ok: true, summary: result.summary });
});

export default router;
