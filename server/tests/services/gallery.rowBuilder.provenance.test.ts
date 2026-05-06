// Tests that provenance + fingerprint fields thread through buildRowsFromHistory.

import { describe, expect, it } from 'vitest';
import { buildRowsFromHistory } from '../../src/services/gallery.rowBuilder.js';
import type { ApiPrompt } from '../../src/services/gallery.extract.js';

const OUTPUTS = {
  '7': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] },
};

const API_PROMPT: ApiPrompt = {
  '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'flux.safetensors' } },
};

describe('buildRowsFromHistory provenance', () => {
  it('propagates triggeredBy when present', () => {
    const rows = buildRowsFromHistory({
      promptId: 'p1', outputs: OUTPUTS, apiPrompt: API_PROMPT,
      createdAt: 1000, triggeredBy: 'ui',
    });
    expect(rows[0].triggeredBy).toBe('ui');
    expect(rows[0].conversationId).toBeNull();
    expect(rows[0].messageId).toBeNull();
  });

  it('propagates chat provenance with conversationId + messageId', () => {
    const rows = buildRowsFromHistory({
      promptId: 'p2', outputs: OUTPUTS, apiPrompt: API_PROMPT,
      createdAt: 2000, triggeredBy: 'chat', conversationId: 'conv-1', messageId: 'msg-2',
    });
    expect(rows[0].triggeredBy).toBe('chat');
    expect(rows[0].conversationId).toBe('conv-1');
    expect(rows[0].messageId).toBe('msg-2');
  });

  it('propagates mcp triggeredBy', () => {
    const rows = buildRowsFromHistory({
      promptId: 'p3', outputs: OUTPUTS, apiPrompt: API_PROMPT,
      createdAt: 3000, triggeredBy: 'mcp',
    });
    expect(rows[0].triggeredBy).toBe('mcp');
  });

  it('defaults to null when no provenance given', () => {
    const rows = buildRowsFromHistory({
      promptId: 'p4', outputs: OUTPUTS, apiPrompt: API_PROMPT, createdAt: 4000,
    });
    expect(rows[0].triggeredBy).toBeNull();
    expect(rows[0].conversationId).toBeNull();
    expect(rows[0].messageId).toBeNull();
  });

  it('propagates modelFingerprint and templateHash', () => {
    const rows = buildRowsFromHistory({
      promptId: 'p5', outputs: OUTPUTS, apiPrompt: API_PROMPT,
      createdAt: 5000, modelFingerprint: '{"flux.safetensors":"123-456"}', templateHash: 'abcdef1234567890',
    });
    expect(rows[0].modelFingerprint).toBe('{"flux.safetensors":"123-456"}');
    expect(rows[0].templateHash).toBe('abcdef1234567890');
  });

  it('all rows in a multi-output batch share the same provenance', () => {
    const multiOutputs = {
      '7': { images: [
        { filename: '1.png', subfolder: '', type: 'output' },
        { filename: '2.png', subfolder: '', type: 'output' },
      ] },
    };
    const rows = buildRowsFromHistory({
      promptId: 'p6', outputs: multiOutputs, apiPrompt: API_PROMPT,
      createdAt: 6000, triggeredBy: 'chat', conversationId: 'c1',
    });
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.triggeredBy).toBe('chat');
      expect(r.conversationId).toBe('c1');
    }
  });
});
