// Wrapper-aware LiteGraph detection.
//
// Coverage:
//   - raw LiteGraph passes through with empty defaults.
//   - TemplateData wrapper produces the inner workflow + extracted defaults.
//   - garbage / non-objects / missing nodes return null.
//   - mixed shape: wrapper field present but inner workflow is not LiteGraph.
//   - tags filter drops non-string entries.

import { describe, expect, it } from 'vitest';
import { extractLitegraph } from '../../../src/services/templates/extractLitegraph.js';

function rawWorkflow(): Record<string, unknown> {
  return {
    nodes: [
      { id: 1, type: 'UNETLoader', properties: { models: [{ name: 'm.safetensors' }] } },
      { id: 2, type: 'SaveImage', widgets_values: ['out'] },
    ],
    links: [],
  };
}

describe('extractLitegraph', () => {
  it('returns the workflow itself with empty defaults for a raw LiteGraph', () => {
    const wf = rawWorkflow();
    const out = extractLitegraph(wf);
    expect(out).not.toBeNull();
    expect(out!.workflow).toBe(wf);
    expect(out!.defaults).toEqual({});
  });

  it('extracts inner workflow + defaults from a TemplateData wrapper', () => {
    const wrapped = {
      name: 'studio-foo',
      title: 'Foo Workflow',
      description: 'A test wrapper.',
      tags: ['tag-a', 'tag-b'],
      thumbnail: ['https://example.test/thumb.png'],
      workflow: rawWorkflow(),
    };
    const out = extractLitegraph(wrapped);
    expect(out).not.toBeNull();
    expect(out!.workflow).toBe(wrapped.workflow);
    expect(out!.defaults).toEqual({
      defaultTitle: 'Foo Workflow',
      defaultDescription: 'A test wrapper.',
      defaultTags: ['tag-a', 'tag-b'],
      defaultThumbnail: 'https://example.test/thumb.png',
    });
  });

  it('drops non-string entries from the tags array', () => {
    const wrapped = {
      title: 'T',
      tags: ['ok', 42, null, { name: 'bad' }, 'also-ok'],
      workflow: rawWorkflow(),
    };
    const out = extractLitegraph(wrapped);
    expect(out!.defaults.defaultTags).toEqual(['ok', 'also-ok']);
  });

  it('omits thumbnail when the first element is not a string', () => {
    const wrapped = {
      thumbnail: [42, 'second'],
      workflow: rawWorkflow(),
    };
    const out = extractLitegraph(wrapped);
    expect(out!.defaults.defaultThumbnail).toBeUndefined();
  });

  it('omits defaults when the wrapper does not provide them', () => {
    const out = extractLitegraph({ workflow: rawWorkflow() });
    expect(out).not.toBeNull();
    expect(out!.defaults).toEqual({});
  });

  it('returns null for non-objects', () => {
    expect(extractLitegraph(null)).toBeNull();
    expect(extractLitegraph(undefined)).toBeNull();
    expect(extractLitegraph('string')).toBeNull();
    expect(extractLitegraph(42)).toBeNull();
    expect(extractLitegraph([])).toBeNull();
  });

  it('returns null for objects without nodes (raw shape) and without a wrapper field', () => {
    expect(extractLitegraph({ foo: 'bar' })).toBeNull();
    expect(extractLitegraph({ nodes: 'not-an-array' })).toBeNull();
  });

  it('returns null when wrapper.workflow is present but not a LiteGraph', () => {
    // Mixed shape: looks wrapper-ish but inner is garbage. The function must
    // refuse rather than return the broken inner — otherwise downstream
    // staging would fail with a confusing error.
    const out = extractLitegraph({ title: 'x', workflow: { foo: 'bar' } });
    expect(out).toBeNull();
  });

  it('accepts an empty nodes array (legitimate empty workflow)', () => {
    const out = extractLitegraph({ nodes: [] });
    expect(out).not.toBeNull();
    expect(out!.workflow).toEqual({ nodes: [] });
  });
});
