import { describe, expect, it } from 'vitest';
import { workflowHash, isFullCacheHit } from '../../src/lib/workflowHash.js';

describe('workflowHash', () => {
  it('produces same hash regardless of key order', () => {
    const a = { '3': { class_type: 'LoadImage', inputs: { image: 'cat.png', upload: 'image' } } };
    const b = { '3': { inputs: { upload: 'image', image: 'cat.png' }, class_type: 'LoadImage' } };
    expect(workflowHash(a)).toBe(workflowHash(b));
  });

  it('ignores _meta differences', () => {
    const a = { '3': { class_type: 'LoadImage', inputs: { image: 'cat.png' }, _meta: { title: 'Load Image' } } };
    const b = { '3': { class_type: 'LoadImage', inputs: { image: 'cat.png' }, _meta: { title: 'renamed' } } };
    expect(workflowHash(a)).toBe(workflowHash(b));
  });

  it('differs when any input changes', () => {
    const a = { '3': { class_type: 'LoadImage', inputs: { image: 'cat.png' } } };
    const b = { '3': { class_type: 'LoadImage', inputs: { image: 'dog.png' } } };
    expect(workflowHash(a)).not.toBe(workflowHash(b));
  });

  it('returns empty string for null/non-object input', () => {
    expect(workflowHash(null)).toBe('');
    expect(workflowHash(undefined)).toBe('');
    expect(workflowHash('string')).toBe('');
  });

  it('produces a stable 16-char hex string', () => {
    const h = workflowHash({ foo: 'bar' });
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('isFullCacheHit', () => {
  it('true when execution_cached covers every node', () => {
    const apiPrompt = { '3': {}, '23': {}, '30': {} };
    const messages = [
      ['execution_start', {}],
      ['execution_cached', { nodes: ['3', '23', '30'], prompt_id: 'p1' }],
      ['execution_success', {}],
    ];
    expect(isFullCacheHit(messages, apiPrompt)).toBe(true);
  });

  it('false when partial cache (some nodes re-ran)', () => {
    const apiPrompt = { '3': {}, '23': {}, '30': {} };
    const messages = [['execution_cached', { nodes: ['3'] }]];
    expect(isFullCacheHit(messages, apiPrompt)).toBe(false);
  });

  it('false when no execution_cached message', () => {
    const apiPrompt = { '3': {} };
    const messages = [['execution_success', {}]];
    expect(isFullCacheHit(messages, apiPrompt)).toBe(false);
  });

  it('false when messages or prompt missing', () => {
    expect(isFullCacheHit(null, { '3': {} })).toBe(false);
    expect(isFullCacheHit([], null)).toBe(false);
    expect(isFullCacheHit([['execution_cached', { nodes: [] }]], {})).toBe(false);
  });
});
