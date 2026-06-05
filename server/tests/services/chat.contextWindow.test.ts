// Phase F context-window service tests. Stubs `fetch` for the /api/show
// path and uses a fresh sqlite DB for the computeUsage flow.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computeUsage,
  estimateTokens,
  getModelContext,
  parseNumCtx,
  _resetContextCache,
} from '../../src/services/chat/contextWindow.js';
import * as repo from '../../src/lib/db/chat.repo.js';
import * as ctxRepo from '../../src/lib/db/chat.context.repo.js';
import { useFreshDb } from '../lib/db/_helpers.js';

// computeUsage reads budget from getLoadedContextLength (ollama.js /api/ps),
// not from /api/show. Mock at the module boundary to avoid real HTTP.
vi.mock('../../src/services/chat/ollama.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/services/chat/ollama.js')>();
  return { ...actual, getLoadedContextLength: vi.fn() };
});
import * as ollamaMod from '../../src/services/chat/ollama.js';

describe('estimateTokens', () => {
  it('returns 0 for empty input', () => {
    expect(estimateTokens('')).toBe(0);
  });
  it('uses the larger of char/4 vs words*1.3', () => {
    // 16-char single word -> chars/4 = 4, words*1.3 = 1.3 -> char path wins.
    expect(estimateTokens('aaaaaaaaaaaaaaaa')).toBe(4);
    // Five short words -> words*1.3 = 6.5 -> word path wins (5 chars total /4 = 2).
    expect(estimateTokens('a b c d e')).toBe(7);
  });
});

describe('parseNumCtx', () => {
  it('reads num_ctx from the parameters string', () => {
    expect(parseNumCtx({
      parameters: 'stop "<|endoftext|>"\nnum_ctx 8192\nrope_freq_base 1000000',
    })).toBe(8192);
  });

  it('reads context_length from model_info architecture entry', () => {
    expect(parseNumCtx({
      model_info: { 'llama.context_length': 131072 },
    })).toBe(131072);
  });

  it('prefers the larger of params vs model_info', () => {
    expect(parseNumCtx({
      parameters: 'num_ctx 4096',
      model_info: { 'llama.context_length': 131072 },
    })).toBe(131072);
  });

  it('returns null when neither field carries a budget', () => {
    expect(parseNumCtx({})).toBeNull();
    expect(parseNumCtx({ parameters: 'temperature 0.7' })).toBeNull();
    expect(parseNumCtx({ model_info: { 'arch.embedding_length': 4096 } })).toBeNull();
  });
});

describe('getModelContext', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    _resetContextCache();
  });
  afterEach(() => {
    vi.stubGlobal('fetch', realFetch);
    vi.restoreAllMocks();
  });

  it('extracts num_ctx from /api/show response', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      parameters: 'num_ctx 32768',
      model_info: {},
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const info = await getModelContext('llama3:8b');
    expect(info).toEqual({ num_ctx: 32768, model: 'llama3:8b' });
  });

  it('returns null when /api/show is unreachable', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockRejectedValueOnce(new Error('econnrefused'));
    const info = await getModelContext('phantom-model');
    expect(info).toBeNull();
  });

  it('caches per-model results', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      parameters: 'num_ctx 4096',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await getModelContext('cached:1');
    // Second call MUST NOT hit the network — only one fetch call recorded.
    await getModelContext('cached:1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('computeUsage', () => {
  useFreshDb();
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    _resetContextCache();
    vi.mocked(ollamaMod.getLoadedContextLength).mockReset();
  });
  afterEach(() => {
    vi.stubGlobal('fetch', realFetch);
    vi.restoreAllMocks();
  });

  it('returns null budget when /api/ps is unreachable', async () => {
    vi.mocked(ollamaMod.getLoadedContextLength).mockResolvedValueOnce(null);
    repo.createConversation({
      id: 'c', title: 't', model: 'm', created_at: 0, updated_at: 0,
    });
    const usage = await computeUsage({
      conversationId: 'c', model: 'm',
    });
    // budget is null when we can't determine context length from /api/ps.
    expect(usage.budget).toBeNull();
    expect(typeof usage.used).toBe('number');
    expect(usage.percent).toBe(0);
    expect(usage.strategy).toBe('sliding');
  });

  it('reads tokens_in from the latest assistant message', async () => {
    vi.mocked(ollamaMod.getLoadedContextLength).mockResolvedValueOnce(8192);
    repo.createConversation({
      id: 'c2', title: 't', model: 'm', created_at: 0, updated_at: 0,
    });
    repo.appendMessage({
      id: 'a1', conversation_id: 'c2', role: 'assistant',
      parts: JSON.stringify([{ type: 'text', text: 'hello' }]),
      created_at: 100,
      telemetry: { tokens_in: 1024, tokens_out: 50, model: 'm' },
    });
    const usage = await computeUsage({
      conversationId: 'c2', model: 'm', pendingUserText: 'next question',
    });
    expect(usage.budget).toBe(8192);
    // estimatedNext includes system-prompt tokens + pending text tokens.
    expect(usage.estimatedNext).toBeGreaterThan(0);
    // consumed (1024) + estimatedNext
    expect(usage.used).toBe(1024 + usage.estimatedNext);
  });

  it('classifies warning levels correctly', async () => {
    vi.mocked(ollamaMod.getLoadedContextLength).mockResolvedValue(1000);
    repo.createConversation({
      id: 'c3', title: 't', model: 'm', created_at: 0, updated_at: 0,
    });
    // Append with tokens_in large enough to push > 80% of budget=1000.
    repo.appendMessage({
      id: 'a3', conversation_id: 'c3', role: 'assistant',
      parts: '[]', created_at: 1, telemetry: { tokens_in: 850 },
    });
    const usage = await computeUsage({ conversationId: 'c3', model: 'm' });
    expect(usage.warning).toBe('red');
    expect(usage.percent).toBeGreaterThanOrEqual(80);
  });

  it('uses the conversation strategy from the repo', async () => {
    vi.mocked(ollamaMod.getLoadedContextLength).mockResolvedValueOnce(4096);
    repo.createConversation({
      id: 'c4', title: 't', model: 'm', created_at: 0, updated_at: 0,
      context_strategy: 'auto',
    });
    expect(ctxRepo.getStrategy('c4')).toBe('auto');
    const usage = await computeUsage({ conversationId: 'c4', model: 'm' });
    expect(usage.strategy).toBe('auto');
  });
});
