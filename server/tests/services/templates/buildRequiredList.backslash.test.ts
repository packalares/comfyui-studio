// buildRequiredList: Windows-style backslash filenames normalize to basename
// for catalog lookup AND for matching against the orchestrator's resolution
// map.
//
// Audit C4: `filename.split('/').pop()` before normalizing `\` → `/` caused
// `flux1\ae.safetensors` to yield the whole string as the basename, making
// the catalog lookup fail and the model appear missing even when installed.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../src/services/catalog/index.js', () => ({
  getModel: vi.fn(),
  getModelByPair: vi.fn(),
  isSizeStale: vi.fn().mockReturnValue(false),
}));

vi.mock('../../../src/lib/db/modelFiles.repo.js', () => ({
  listByFilename: vi.fn().mockReturnValue([]),
  findByDirAndName: vi.fn().mockReturnValue(null),
}));

vi.mock('../../../src/config/env.js', () => ({
  env: { COMFYUI_PATH: '/comfyui', NODE_ENV: 'test' },
}));

import { buildRequiredList } from '../../../src/services/templates/dependencyCheck.models.js';
import * as catalog from '../../../src/services/catalog/index.js';

describe('buildRequiredList — backslash normalization (C4)', () => {
  beforeEach(() => {
    vi.mocked(catalog.getModel).mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it('resolves flux1\\ae.safetensors basename to ae.safetensors for catalog lookup', () => {
    vi.mocked(catalog.getModel).mockImplementation((fn: string) => {
      if (fn === 'ae.safetensors') {
        return {
          filename: 'ae.safetensors', name: 'FLUX AE', type: 'vae',
          save_path: 'vae', url: 'https://huggingface.co/x/y/resolve/main/ae.safetensors',
          size_pretty: '335 MB', size_bytes: 335 * 1024 * 1024, size_fetched_at: null,
          source: 'comfyui',
        };
      }
      return undefined;
    });

    // Orchestrator resolution keyed under the backslash form (mirrors how
    // extractHashHints surfaces the raw widget value before normalization).
    const presenceResolutions = new Map([
      ['flux1\\ae.safetensors', {
        filename: 'ae.safetensors',
        save_path: 'vae',
        abs_path: '/comfyui/models/vae/ae.safetensors',
        size: 335 * 1024 * 1024,
      }],
    ]);

    const { required, missing } = buildRequiredList({
      requiredFilenames: new Set(['flux1\\ae.safetensors']),
      templateDir: new Map(),
      modelFolders: {},
      installedModels: [{
        name: 'FLUX AE', filename: 'ae.safetensors', type: 'vae',
        save_path: 'vae', url: '', installed: true,
      }],
      presenceResolutions,
      repoEntries: new Map(),
    });

    expect(required).toHaveLength(1);
    // The entry should use the derived basename, not the raw backslash string.
    expect(required[0].name).toBe('ae.safetensors');
    // The catalog row was found via basename lookup, so url is populated.
    expect(required[0].url).toContain('huggingface.co');
    // Orchestrator resolved it → installed.
    expect(required[0].installed).toBe(true);
    expect(missing).toHaveLength(0);
  });

  it('catalog lookup is called with the basename (ae.safetensors) not the raw path', () => {
    vi.mocked(catalog.getModel).mockReturnValue(undefined);

    buildRequiredList({
      requiredFilenames: new Set(['subdir\\ae.safetensors']),
      templateDir: new Map(),
      modelFolders: {},
      installedModels: [],
      presenceResolutions: new Map(),
      repoEntries: new Map(),
    });

    const calls = vi.mocked(catalog.getModel).mock.calls.map(c => c[0]);
    // Must include the plain basename, never the raw backslash form.
    expect(calls.some(c => c === 'ae.safetensors')).toBe(true);
    expect(calls.some(c => c.includes('\\'))).toBe(false);
  });
});
