import { describe, expect, it } from 'vitest';
import * as repo from '../../../src/lib/db/chat.repo.js';
import { useFreshDb } from './_helpers.js';

function mkConv(id: string, updated_at = 100) {
  repo.createConversation({
    id, title: id, model: 'm', created_at: 0, updated_at,
  });
}

describe('chat repo — bulk delete + pin', () => {
  useFreshDb();

  // ── Bulk delete ──────────────────────────────────────────────────────────

  it('deleteAllConversations returns count and leaves table empty', () => {
    mkConv('a');
    mkConv('b');
    mkConv('c');
    const count = repo.deleteAllConversations();
    expect(count).toBe(3);
    expect(repo.listConversations().items).toHaveLength(0);
  });

  it('deleteAllConversations cascades to messages', () => {
    mkConv('x');
    repo.appendMessage({ id: 'm1', conversation_id: 'x', role: 'user', parts: '[]', created_at: 1 });
    repo.appendMessage({ id: 'm2', conversation_id: 'x', role: 'assistant', parts: '[]', created_at: 2 });
    repo.deleteAllConversations();
    expect(repo.listMessages('x')).toHaveLength(0);
  });

  it('deleteAllConversations on empty table returns 0', () => {
    expect(repo.deleteAllConversations()).toBe(0);
  });

  // ── setPinned ────────────────────────────────────────────────────────────

  it('setPinned returns false for unknown id', () => {
    expect(repo.setPinned('nope', true)).toBe(false);
  });

  it('setPinned round-trips pin/unpin', () => {
    mkConv('p');
    expect(repo.getConversation('p')?.pinned).toBe(false);
    expect(repo.setPinned('p', true)).toBe(true);
    expect(repo.getConversation('p')?.pinned).toBe(true);
    expect(repo.setPinned('p', false)).toBe(true);
    expect(repo.getConversation('p')?.pinned).toBe(false);
  });

  // ── listConversations sort order with pinned ─────────────────────────────

  it('pinned conversations sort above unpinned regardless of updated_at', () => {
    mkConv('old-pinned', 100);
    mkConv('new-unpinned', 999);
    mkConv('another-unpinned', 500);
    repo.setPinned('old-pinned', true);

    const { items } = repo.listConversations();
    expect(items[0].id).toBe('old-pinned');
    // Remaining two should be sorted newest-first among themselves
    expect(items[1].id).toBe('new-unpinned');
    expect(items[2].id).toBe('another-unpinned');
  });

  it('multiple pinned rows sort among themselves by updated_at desc', () => {
    mkConv('pinA', 200);
    mkConv('pinB', 400);
    mkConv('unpinC', 600);
    repo.setPinned('pinA', true);
    repo.setPinned('pinB', true);

    const { items } = repo.listConversations();
    expect(items[0].id).toBe('pinB');
    expect(items[1].id).toBe('pinA');
    expect(items[2].id).toBe('unpinC');
  });

  // ── PATCH pinned via renameConversation ──────────────────────────────────

  it('renameConversation with pinned:true sets pinned flag', () => {
    mkConv('q');
    expect(repo.renameConversation('q', { pinned: true }, Date.now())).toBe(true);
    expect(repo.getConversation('q')?.pinned).toBe(true);
  });
});
