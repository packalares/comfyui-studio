// Coverage for the markdown prompts/suggestions loader.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpRoot: string;
let savedConfigRoot: string | undefined;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prompts-loader-test-'));
  savedConfigRoot = process.env.STUDIO_CONFIG_ROOT;
  process.env.STUDIO_CONFIG_ROOT = tmpRoot;
  // Reset modules so paths.ts + the loader re-read env / re-parse the file.
  vi.resetModules();
});

afterEach(() => {
  if (savedConfigRoot !== undefined) process.env.STUDIO_CONFIG_ROOT = savedConfigRoot;
  else delete process.env.STUDIO_CONFIG_ROOT;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeUserOverlay(body: string): void {
  const dir = path.join(tmpRoot, 'chat');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'default_prompts.md'), body);
}

// ---- Bundled file (no overlay) ------------------------------------------

describe('promptsLoader — bundled file', () => {
  it('reads a section verbatim with `get`', async () => {
    const { get } = await import('../../src/services/chat/promptsLoader.js');
    // Bundled `tool-error-reprompt` body is `tool error: {{errorMessage}}`.
    expect(get('tool-error-reprompt')).toContain('{{errorMessage}}');
  });

  it('returns empty list for unknown key from getList', async () => {
    const { getList } = await import('../../src/services/chat/promptsLoader.js');
    expect(getList('does-not-exist')).toEqual([]);
  });

  it('parses bullet-list section with `getList`', async () => {
    const { getList } = await import('../../src/services/chat/promptsLoader.js');
    const list = getList('suggestions.empty-state');
    expect(list.length).toBeGreaterThan(0);
    expect(list.every(s => s.length > 0)).toBe(true);
  });

  it('substitutes {{var}} with `template`', async () => {
    const { template } = await import('../../src/services/chat/promptsLoader.js');
    const out = template('tool-error-reprompt', { errorMessage: 'boom' });
    expect(out).toBe('tool error: boom');
  });

  it('leaves unknown {{vars}} as literals (loud)', async () => {
    const { template } = await import('../../src/services/chat/promptsLoader.js');
    const out = template('tool-error-reprompt', {});
    expect(out).toContain('{{errorMessage}}');
  });

  it('builds frozen tool-label maps', async () => {
    const { getToolLabels, getToolLabelDescriptions } = await import('../../src/services/chat/promptsLoader.js');
    const labels = getToolLabels();
    expect(labels.web_search).toBe('Web search');
    expect(labels.generate_image).toBe('Generate image');
    expect(Object.isFrozen(labels)).toBe(true);
    const desc = getToolLabelDescriptions();
    expect(desc.web_search.length).toBeGreaterThan(0);
  });

  it('returns the full chat-suggestions envelope for /api/system', async () => {
    const { getSuggestions } = await import('../../src/services/chat/promptsLoader.js');
    const s = getSuggestions();
    expect(s.emptyState.length).toBeGreaterThan(0);
    expect(s.contextual.codeFenced.length).toBeGreaterThan(0);
    expect(typeof s.contextual.longReplyExtra).toBe('string');
  });
});

// ---- User overlay wins over bundled -------------------------------------

describe('promptsLoader — user overlay precedence', () => {
  it('user file at <STUDIO_CONFIG_ROOT>/chat/default_prompts.md wins over bundled', async () => {
    writeUserOverlay([
      '## title',
      'OVERRIDDEN_TITLE {{userText}}',
      '',
      '## suggestions.empty-state',
      '- only-from-overlay',
    ].join('\n'));
    const { get, template, getList } = await import('../../src/services/chat/promptsLoader.js');
    expect(get('title')).toContain('OVERRIDDEN_TITLE');
    expect(template('title', { userText: 'hi' })).toBe('OVERRIDDEN_TITLE hi');
    expect(getList('suggestions.empty-state')).toEqual(['only-from-overlay']);
  });

  it('keys present in bundled but absent from a partial user file resolve to "" (loader does not merge)', async () => {
    // Loader treats user file as the ENTIRE source when present — by design,
    // so users can opt fully out of every default. Tests this contract holds.
    writeUserOverlay('## title\nOnly title here.\n');
    const { get } = await import('../../src/services/chat/promptsLoader.js');
    expect(get('title')).toBe('Only title here.');
    expect(get('tool-error-reprompt')).toBe(''); // not in user file → missing → ''
  });
});

// ---- Validation ---------------------------------------------------------

describe('promptsLoader — validation', () => {
  it('validatePromptsFile completes without throwing on the bundled file', async () => {
    const { validatePromptsFile } = await import('../../src/services/chat/promptsLoader.js');
    expect(() => validatePromptsFile()).not.toThrow();
  });
});
