import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseLibraryHtml } from '../../src/services/chat/ollamaLibrary.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(
  path.join(__dirname, '..', 'fixtures', 'ollama_library_sample.html'),
  'utf8',
);

describe('parseLibraryHtml', () => {
  it('extracts every model card', () => {
    const out = parseLibraryHtml(FIXTURE);
    expect(out.length).toBe(3);
    expect(out.map(m => m.name).sort()).toEqual(
      ['llama3.3', 'mistral-small', 'qwen2.5'],
    );
  });

  it('captures pulls / tag count / updated / sizes / capabilities', () => {
    const out = parseLibraryHtml(FIXTURE);
    const qwen = out.find(m => m.name === 'qwen2.5');
    expect(qwen).toBeDefined();
    expect(qwen!.pulls).toBe('3.2M');
    expect(qwen!.tagCount).toBe('40');
    expect(qwen!.updated).toBe('1 month ago');
    expect(qwen!.sizes).toEqual(['0.5b', '1.5b', '7b', '72b']);
    expect(qwen!.capabilities).toEqual(['tools', 'vision']);
  });

  it('decodes HTML entities in description', () => {
    const out = parseLibraryHtml(FIXTURE);
    const m = out.find(c => c.name === 'mistral-small');
    expect(m).toBeDefined();
    expect(m!.description).toBe('Mistral Small & nimble.');
  });

  it('returns empty array on input with no cards', () => {
    expect(parseLibraryHtml('<html><body><p>nothing</p></body></html>')).toEqual([]);
  });

  it('skips cards missing a /library/<name> href', () => {
    const html = `
      <li x-test-model><a href="/other/path"><h2 x-test-model-title>x</h2></a></li>
      <li x-test-model><a href="/library/keep"><h2 x-test-model-title>k</h2></a></li>
    `;
    const out = parseLibraryHtml(html);
    expect(out.length).toBe(1);
    expect(out[0].name).toBe('keep');
  });
});
