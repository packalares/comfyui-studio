import { describe, expect, it } from 'vitest';
import { extractToolCalls } from '../../src/services/chat/ollama.js';

function frame(toolCalls: unknown): unknown {
  return { message: { tool_calls: toolCalls } };
}

describe('extractToolCalls', () => {
  it('returns [] for non-frame inputs', () => {
    expect(extractToolCalls(null)).toEqual([]);
    expect(extractToolCalls('nope')).toEqual([]);
    expect(extractToolCalls({})).toEqual([]);
    expect(extractToolCalls({ message: {} })).toEqual([]);
  });

  it('extracts well-formed tool calls', () => {
    const out = extractToolCalls(frame([
      { function: { name: 'studio_remember', arguments: { fact: 'x' } } },
    ]));
    expect(out).toEqual([
      { function: { name: 'studio_remember', arguments: { fact: 'x' } } },
    ]);
  });

  it('strips Harmony channel markers from tool names (gpt-oss bleed)', () => {
    const out = extractToolCalls(frame([
      { function: { name: 'mcp__context7__resolve_library_id<|channel|>commentary', arguments: {} } },
    ]));
    expect(out[0]?.function.name).toBe('mcp__context7__resolve_library_id');
  });

  it('strips other Harmony tokens too (e.g. <|return|>)', () => {
    const out = extractToolCalls(frame([
      { function: { name: 'studio_remember<|return|>', arguments: {} } },
    ]));
    expect(out[0]?.function.name).toBe('studio_remember');
  });

  it('drops calls whose name becomes empty after sanitization', () => {
    const out = extractToolCalls(frame([
      { function: { name: '<|channel|>commentary', arguments: {} } },
    ]));
    expect(out).toEqual([]);
  });

  it('skips malformed entries without crashing the others', () => {
    const out = extractToolCalls(frame([
      'not-an-object',
      { function: null },
      { function: { name: '' } },
      { function: { name: 'studio_remember', arguments: {} } },
    ]));
    expect(out).toHaveLength(1);
    expect(out[0]?.function.name).toBe('studio_remember');
  });
});
