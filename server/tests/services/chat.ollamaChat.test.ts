import { describe, expect, it } from 'vitest';
import type { UIMessage } from 'ai';
import {
  convertToOllamaMessages,
  extractBase64FromDataUrl,
  iterateNdjson,
  summarizeFinalFrame,
} from '../../src/services/chat/ollamaChat.js';

function uiMsg(role: 'user' | 'assistant' | 'system', parts: unknown[]): UIMessage {
  return { id: 'm', role, parts: parts as never } as UIMessage;
}

function ndjsonStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const text = lines.join('\n');
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // Split mid-buffer to exercise the streaming line accumulator.
      const half = Math.floor(text.length / 2);
      controller.enqueue(encoder.encode(text.slice(0, half)));
      controller.enqueue(encoder.encode(text.slice(half)));
      controller.close();
    },
  });
}

describe('convertToOllamaMessages', () => {
  it('flattens text parts into content', () => {
    const out = convertToOllamaMessages([
      uiMsg('user', [
        { type: 'text', text: 'hello' },
        { type: 'text', text: 'world' },
      ]),
    ], null);
    expect(out).toEqual([{ role: 'user', content: 'hello\nworld' }]);
  });

  it('prepends a system message when systemPrompt is set', () => {
    const out = convertToOllamaMessages(
      [uiMsg('user', [{ type: 'text', text: 'hi' }])],
      'You are a poet.',
    );
    expect(out[0]).toEqual({ role: 'system', content: 'You are a poet.' });
    expect(out[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('skips the system prefix when prompt is empty/null', () => {
    const out = convertToOllamaMessages(
      [uiMsg('user', [{ type: 'text', text: 'hi' }])],
      '',
    );
    expect(out).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('attaches base64 images from data URLs on user messages', () => {
    const out = convertToOllamaMessages([
      uiMsg('user', [
        { type: 'text', text: 'caption please' },
        { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,QUJD' },
      ]),
    ], null);
    expect(out).toEqual([
      { role: 'user', content: 'caption please', images: ['QUJD'] },
    ]);
  });

  it('aggregates multiple images on the same user message', () => {
    const out = convertToOllamaMessages([
      uiMsg('user', [
        { type: 'text', text: 'compare these two' },
        { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,AAA' },
        { type: 'file', mediaType: 'image/jpeg', url: 'data:image/jpeg;base64,BBB' },
      ]),
    ], null);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      role: 'user',
      content: 'compare these two',
      images: ['AAA', 'BBB'],
    });
  });

  it('drops file parts whose URL is not an inline base64 data URL', () => {
    // Ollama only accepts base64 strings — http(s) URLs would 400 upstream.
    const out = convertToOllamaMessages([
      uiMsg('user', [
        { type: 'text', text: 'see attached' },
        { type: 'file', mediaType: 'image/png', url: 'https://example.com/x.png' },
      ]),
    ], null);
    expect(out).toEqual([{ role: 'user', content: 'see attached' }]);
    expect(out[0]).not.toHaveProperty('images');
  });

  it('drops empty messages with no content and no images', () => {
    const out = convertToOllamaMessages([
      uiMsg('user', [{ type: 'text', text: '' }]),
      uiMsg('assistant', []),
    ], null);
    expect(out).toEqual([]);
  });

  it('folds reasoning parts into content so follow-up turns stay coherent', () => {
    const out = convertToOllamaMessages([
      uiMsg('assistant', [
        { type: 'reasoning', text: 'thinking...' },
        { type: 'text', text: 'answer' },
      ]),
    ], null);
    expect(out).toEqual([{ role: 'assistant', content: 'thinking...\nanswer' }]);
  });
});

describe('extractBase64FromDataUrl', () => {
  it('returns the base64 payload', () => {
    expect(extractBase64FromDataUrl('data:image/png;base64,QUJD')).toBe('QUJD');
  });
  it('returns null for non-data URLs', () => {
    expect(extractBase64FromDataUrl('https://example.com/x.png')).toBeNull();
  });
  it('returns null for non-base64 data URLs', () => {
    expect(extractBase64FromDataUrl('data:image/png,raw')).toBeNull();
  });
});

describe('summarizeFinalFrame', () => {
  it('computes tokens_per_sec from eval_count / eval_duration', () => {
    // 100 tokens over 2,000,000,000 ns = 2s -> 50 t/s
    const out = summarizeFinalFrame({
      done: true,
      prompt_eval_count: 12,
      prompt_eval_duration: 500_000_000,
      eval_count: 100,
      eval_duration: 2_000_000_000,
      total_duration: 2_500_000_000,
      load_duration: 0,
    });
    expect(out.tokens_in).toBe(12);
    expect(out.tokens_out).toBe(100);
    expect(out.tokens_per_sec).toBeCloseTo(50, 5);
    expect(out.ms_total_ollama).toBeCloseTo(2500, 1);
    expect(out.ms_load).toBe(0);
  });

  it('returns null t/s when eval_duration is missing or zero', () => {
    expect(summarizeFinalFrame({ eval_count: 10, eval_duration: 0 }).tokens_per_sec).toBeNull();
    expect(summarizeFinalFrame({ eval_count: 10 }).tokens_per_sec).toBeNull();
  });

  it('handles a frame with no telemetry at all', () => {
    expect(summarizeFinalFrame({})).toEqual({
      tokens_in: null,
      tokens_out: null,
      tokens_per_sec: null,
      ms_total_ollama: null,
      ms_load: null,
    });
  });
});

describe('iterateNdjson', () => {
  it('yields one parsed object per line and skips blanks', async () => {
    const stream = ndjsonStream([
      '{"a":1}',
      '',
      '{"b":2}',
      '{"done":true}',
    ]);
    const got: unknown[] = [];
    for await (const v of iterateNdjson(stream)) got.push(v);
    expect(got).toEqual([{ a: 1 }, { b: 2 }, { done: true }]);
  });

  it('flushes a trailing line that lacks a terminating newline', async () => {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('{"x":1}\n{"x":2}'));
        c.close();
      },
    });
    const got: unknown[] = [];
    for await (const v of iterateNdjson(stream)) got.push(v);
    expect(got).toEqual([{ x: 1 }, { x: 2 }]);
  });

  it('emits null for malformed lines without aborting', async () => {
    const stream = ndjsonStream(['{"ok":1}', 'not-json', '{"done":true}']);
    const got: unknown[] = [];
    for await (const v of iterateNdjson(stream)) got.push(v);
    expect(got).toEqual([{ ok: 1 }, null, { done: true }]);
  });
});
