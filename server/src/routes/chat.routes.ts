// Conversation CRUD + streaming kickoff.
//
// `POST /api/chat/start` returns immediately; streaming text + telemetry
// flows over the existing WS as `chat:chunk` / `chat:done` envelopes.
// Aborts go through `POST /api/chat/stop/:msgId`. All other endpoints are
// plain repo passthroughs.

import { Router, type Request, type Response } from 'express';
import type { UIMessage } from 'ai';
import * as chatRepo from '../lib/db/chat.repo.js';
import * as settings from '../services/settings.js';
import { startStream, abortStream } from '../services/chat/streamChat.js';

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
    chatRepo.createConversation({
      id: conversationId,
      title: deriveTitle(messages),
      model: requestedModel,
      system_prompt: systemPrompt,
      created_at: now,
      updated_at: now,
    });
  }

  try {
    const { msgId } = startStream({
      conversationId,
      messages,
      model: requestedModel,
      systemPrompt,
      keepAlive: settings.getChatKeepAlive(),
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

router.get('/chat/conversations', (_req: Request, res: Response) => {
  res.json({ items: chatRepo.listConversations() });
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

router.patch('/chat/conversations/:id', (req: Request, res: Response) => {
  const id = paramStr(req.params.id);
  const body = req.body as {
    title?: unknown;
    model?: unknown;
    system_prompt?: unknown;
  };
  const patch: chatRepo.UpdateConversationPatch = {};
  if (typeof body.title === 'string') patch.title = body.title;
  if (typeof body.model === 'string') patch.model = body.model;
  if (typeof body.system_prompt === 'string' || body.system_prompt === null) {
    patch.system_prompt = body.system_prompt as string | null;
  }
  const ok = chatRepo.renameConversation(id, patch, Date.now());
  if (!ok) { res.status(404).json({ error: 'not found' }); return; }
  const row = chatRepo.getConversation(id);
  res.json(row);
});

export default router;
