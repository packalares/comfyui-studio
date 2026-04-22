import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { extractPrimitiveFormFields } from '../../src/services/workflow/primitiveFields.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, '..', 'fixtures', 'workflows');

describe('extractPrimitiveFormFields', () => {
  it('returns empty for an empty workflow', () => {
    expect(extractPrimitiveFormFields({})).toEqual([]);
  });

  it('skips untitled Primitive nodes', () => {
    const wf = {
      nodes: [{ id: 1, type: 'PrimitiveInt', widgets_values: [42] }], // no title
    };
    expect(extractPrimitiveFormFields(wf)).toEqual([]);
  });

  it('surfaces titled typed Primitive nodes from top-level', () => {
    const wf = {
      nodes: [
        { id: 1, type: 'PrimitiveInt', title: 'Width', widgets_values: [1280] },
        { id: 2, type: 'PrimitiveBoolean', title: 'Auto', widgets_values: [false] },
      ],
    };
    const out = extractPrimitiveFormFields(wf);
    expect(out).toEqual([
      { id: 'primitive:1', label: 'Width', type: 'number', required: false, default: 1280 },
      { id: 'primitive:2', label: 'Auto', type: 'toggle', required: false, default: false },
    ]);
  });

  it('treats a Primitive titled "Prompt" as the main prompt field', () => {
    const wf = {
      nodes: [
        {
          id: 99,
          type: 'PrimitiveStringMultiline',
          title: 'Prompt',
          widgets_values: ['Hello from the workflow'],
        },
      ],
    };
    const out = extractPrimitiveFormFields(wf);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: 'prompt',
      label: 'Prompt',
      type: 'textarea',
      required: true,
      default: 'Hello from the workflow',
    });
  });

  it('walks subgraph definitions as well as top-level nodes', () => {
    const wf = {
      nodes: [
        { id: 1, type: 'LoadImage', widgets_values: ['x.png'] },
      ],
      definitions: {
        subgraphs: [
          {
            id: 'sg1',
            nodes: [
              { id: 10, type: 'PrimitiveInt', title: 'Height', widgets_values: [720] },
              { id: 11, type: 'PrimitiveStringMultiline', title: 'Prompt', widgets_values: ['default text'] },
            ],
          },
        ],
      },
    };
    const out = extractPrimitiveFormFields(wf);
    expect(out).toHaveLength(2);
    const ids = out.map(f => f.id).sort();
    expect(ids).toEqual(['primitive:10', 'prompt']);
  });

  it('dedupes by field id — first occurrence wins', () => {
    const wf = {
      nodes: [
        { id: 1, type: 'PrimitiveStringMultiline', title: 'Prompt', widgets_values: ['first'] },
        { id: 2, type: 'PrimitiveStringMultiline', title: 'Prompt', widgets_values: ['second'] },
      ],
    };
    const out = extractPrimitiveFormFields(wf);
    expect(out).toHaveLength(1);
    expect(out[0].default).toBe('first');
  });

  it('covers the LTX2 workflow fixture end-to-end', () => {
    const wf = JSON.parse(
      fs.readFileSync(path.join(FIX, 'ltx2_i2v.workflow.json'), 'utf8'),
    );
    const out = extractPrimitiveFormFields(wf);
    const byId = new Map(out.map(f => [f.id, f]));
    // The LTX2 subgraph carries five titled Primitives + the Prompt multiline.
    expect(byId.get('prompt')?.type).toBe('textarea');
    expect(typeof byId.get('prompt')?.default).toBe('string');
    expect((byId.get('prompt')?.default as string).startsWith('Egyptian royal')).toBe(true);
    // Width / Height / Length / Frame Rate are all PrimitiveInt with titles.
    const labels = out.map(f => f.label);
    expect(labels).toContain('Width');
    expect(labels).toContain('Height');
    expect(labels).toContain('Length');
    expect(labels).toContain('Frame Rate');
    expect(labels).toContain('Switch to Text to Video?');
  });
});
