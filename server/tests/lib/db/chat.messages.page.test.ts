// Tests for `listMessagesPage` — cursor-based pagination over chat_messages.
//
// Ids in this codebase are random base-36 strings, so (created_at, id)
// is the canonical sort key. These tests verify that the pagination logic
// respects that compound key, not a naive id-only comparison.

import { describe, expect, it } from 'vitest';
import * as repo from '../../../src/lib/db/chat.repo.js';
import { useFreshDb } from './_helpers.js';

const NOW = 1_000_000;

function seed(convId: string, count: number): string[] {
  repo.createConversation({
    id: convId, title: 't', model: 'm',
    created_at: NOW, updated_at: NOW,
  });
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `msg${String(i).padStart(3, '0')}`;
    repo.appendMessage({
      id,
      conversation_id: convId,
      role: i % 2 === 0 ? 'user' : 'assistant',
      parts: JSON.stringify([{ type: 'text', text: `message ${i}` }]),
      // Each message gets a distinct created_at so sort order is deterministic.
      created_at: NOW + i,
    });
    ids.push(id);
  }
  return ids;
}

describe('listMessagesPage', () => {
  useFreshDb();

  it('default page (no before) returns latest N messages with hasMore=false for small conv', () => {
    const ids = seed('c1', 10);
    const result = repo.listMessagesPage('c1', { limit: 50 });
    // All 10 messages fit within limit=50.
    expect(result.items.length).toBe(10);
    expect(result.hasMore).toBe(false);
    // Returned in ASC order (oldest first).
    expect(result.items[0].id).toBe(ids[0]);
    expect(result.items[9].id).toBe(ids[9]);
    expect(result.oldestId).toBe(ids[0]);
  });

  it('limit=3 returns the 3 newest messages, hasMore=true when more exist', () => {
    const ids = seed('c2', 10);
    const result = repo.listMessagesPage('c2', { limit: 3 });
    expect(result.items.length).toBe(3);
    expect(result.hasMore).toBe(true);
    // The 3 newest in ASC order.
    expect(result.items[0].id).toBe(ids[7]);
    expect(result.items[1].id).toBe(ids[8]);
    expect(result.items[2].id).toBe(ids[9]);
    expect(result.oldestId).toBe(ids[7]);
  });

  it('before cursor returns the page strictly older than the cursor', () => {
    const ids = seed('c3', 10);
    // Ask for the 3 messages older than msg007 (index 7).
    const result = repo.listMessagesPage('c3', { limit: 3, before: ids[7] });
    expect(result.items.length).toBe(3);
    // Should be ids[4], ids[5], ids[6] in ASC order.
    expect(result.items[0].id).toBe(ids[4]);
    expect(result.items[1].id).toBe(ids[5]);
    expect(result.items[2].id).toBe(ids[6]);
    // ids[0..3] still exist, so hasMore=true.
    expect(result.hasMore).toBe(true);
    expect(result.oldestId).toBe(ids[4]);
  });

  it('before cursor at the earliest message returns hasMore=false', () => {
    const ids = seed('c4', 5);
    // msg001 is the second-oldest; only msg000 is older.
    const result = repo.listMessagesPage('c4', { limit: 50, before: ids[1] });
    expect(result.items.length).toBe(1);
    expect(result.items[0].id).toBe(ids[0]);
    expect(result.hasMore).toBe(false);
    expect(result.oldestId).toBe(ids[0]);
  });

  it('empty conversation returns empty page', () => {
    repo.createConversation({
      id: 'empty', title: 't', model: 'm', created_at: NOW, updated_at: NOW,
    });
    const result = repo.listMessagesPage('empty', { limit: 50 });
    expect(result.items).toEqual([]);
    expect(result.hasMore).toBe(false);
    expect(result.oldestId).toBeNull();
  });

  it('before cursor not found in conversation returns empty page', () => {
    seed('c5', 5);
    const result = repo.listMessagesPage('c5', { limit: 50, before: 'nonexistent-id' });
    expect(result.items).toEqual([]);
    expect(result.hasMore).toBe(false);
    expect(result.oldestId).toBeNull();
  });

  it('limit is clamped to [1, 200] inside the repo', () => {
    const ids = seed('c6', 5);
    // limit=0 is clamped to 1 — returns only the newest message.
    const r0 = repo.listMessagesPage('c6', { limit: 0 });
    expect(r0.items.length).toBe(1);
    expect(r0.items[0].id).toBe(ids[4]);
    // limit=999 is clamped to 200 — returns all 5 since 5 < 200.
    const r999 = repo.listMessagesPage('c6', { limit: 999 });
    expect(r999.items.length).toBe(5);
  });

  it('listMessages (full load) is unaffected by the new method', () => {
    const ids = seed('c7', 5);
    const full = repo.listMessages('c7');
    expect(full.length).toBe(5);
    expect(full[0].id).toBe(ids[0]);
    expect(full[4].id).toBe(ids[4]);
  });
});
