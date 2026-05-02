import { describe, expect, it } from 'vitest';
import * as repo from '../../../src/lib/db/chat.repo.js';
import { useFreshDb } from './_helpers.js';

describe('chat repo', () => {
  useFreshDb();

  it('createConversation + getConversation round-trips', () => {
    const now = Date.now();
    repo.createConversation({
      id: 'c1',
      title: 'My chat',
      model: 'llama3.3',
      system_prompt: null,
      created_at: now,
      updated_at: now,
    });
    const got = repo.getConversation('c1');
    expect(got).not.toBeNull();
    expect(got?.title).toBe('My chat');
    expect(got?.model).toBe('llama3.3');
    expect(got?.system_prompt).toBeNull();
  });

  it('listConversations sorts by updated_at desc', () => {
    repo.createConversation({
      id: 'a', title: 't', model: 'm', created_at: 1, updated_at: 100,
    });
    repo.createConversation({
      id: 'b', title: 't', model: 'm', created_at: 1, updated_at: 300,
    });
    repo.createConversation({
      id: 'c', title: 't', model: 'm', created_at: 1, updated_at: 200,
    });
    const out = repo.listConversations();
    expect(out.map(r => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('appendMessage + listMessages retrieves in created_at order', () => {
    repo.createConversation({
      id: 'c', title: 't', model: 'm', created_at: 0, updated_at: 0,
    });
    repo.appendMessage({
      id: 'm1', conversation_id: 'c', role: 'user',
      parts: JSON.stringify([{ type: 'text', text: 'hi' }]),
      created_at: 1,
    });
    repo.appendMessage({
      id: 'm2', conversation_id: 'c', role: 'assistant',
      parts: JSON.stringify([{ type: 'text', text: 'hello' }]),
      created_at: 2,
      telemetry: {
        tokens_in: 10, tokens_out: 20, ms_total: 500,
        ms_to_first_token: 50, tokens_per_sec: 40, model: 'm',
      },
    });
    const list = repo.listMessages('c');
    expect(list.length).toBe(2);
    expect(list[0].id).toBe('m1');
    expect(list[1].id).toBe('m2');
    expect(list[1].tokens_out).toBe(20);
    expect(list[1].tokens_per_sec).toBe(40);
  });

  it('deleteConversation cascades to messages', () => {
    repo.createConversation({
      id: 'd', title: 't', model: 'm', created_at: 0, updated_at: 0,
    });
    repo.appendMessage({
      id: 'mx', conversation_id: 'd', role: 'user',
      parts: '[]', created_at: 1,
    });
    expect(repo.listMessages('d').length).toBe(1);
    expect(repo.deleteConversation('d')).toBe(true);
    expect(repo.getConversation('d')).toBeNull();
    expect(repo.listMessages('d').length).toBe(0);
  });

  it('renameConversation updates title + bumps updated_at', () => {
    repo.createConversation({
      id: 'r', title: 'old', model: 'm', created_at: 0, updated_at: 100,
    });
    expect(repo.renameConversation('r', { title: 'new' }, 999)).toBe(true);
    const got = repo.getConversation('r');
    expect(got?.title).toBe('new');
    expect(got?.updated_at).toBe(999);
  });

  it('updateMessageTelemetry persists new telemetry', () => {
    repo.createConversation({
      id: 'u', title: 't', model: 'm', created_at: 0, updated_at: 0,
    });
    repo.appendMessage({
      id: 'mu', conversation_id: 'u', role: 'assistant',
      parts: '[]', created_at: 1,
    });
    expect(repo.updateMessageTelemetry('mu', {
      tokens_in: 5, tokens_out: 10, ms_total: 100,
    })).toBe(true);
    const list = repo.listMessages('u');
    expect(list[0].tokens_in).toBe(5);
    expect(list[0].tokens_out).toBe(10);
    expect(list[0].ms_total).toBe(100);
  });

  it('updateMessageParts mutates the parts column', () => {
    repo.createConversation({
      id: 'p', title: 't', model: 'm', created_at: 0, updated_at: 0,
    });
    repo.appendMessage({
      id: 'mp', conversation_id: 'p', role: 'assistant',
      parts: JSON.stringify([{ type: 'text', text: 'a' }]),
      created_at: 1,
    });
    expect(repo.updateMessageParts(
      'mp', JSON.stringify([{ type: 'text', text: 'ab' }]),
    )).toBe(true);
    const list = repo.listMessages('p');
    expect(list[0].parts).toContain('ab');
  });

  it('renameConversation returns false for unknown id', () => {
    expect(repo.renameConversation('nope', { title: 'x' }, 1)).toBe(false);
  });
});
