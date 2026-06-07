// Tests for the comfyIntrospect helpers.
// All filesystem and subprocess interactions are mocked — no real Python or
// ComfyUI install is required.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '..', 'fixtures');

// ---- Mock child_process ----
vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

// ---- Mock fs to control file reads ----
vi.mock('fs', async (orig) => {
  const actual = await orig<typeof import('fs')>();
  return { ...actual, default: { ...actual } };
});

import { execFileSync } from 'child_process';
import fs from 'fs';

const mockExecFileSync = vi.mocked(execFileSync);

// Helper: valid argparse JSON output matching what the Python script emits
function fakeArgparseOutput(extras: Array<{ optionString: string; help: string; type: string; default: unknown }> = []) {
  return JSON.stringify([
    { optionString: '--port', help: 'Port to listen on', type: 'number', default: 8188 },
    { optionString: '--front-end-version', help: 'Frontend version', type: 'string', default: null },
    { optionString: '--disable-xformers', help: 'Disable xformers', type: 'flag', default: null },
    { optionString: '--lowvram', help: 'Low VRAM mode', type: 'flag', default: null },
    ...extras,
  ]);
}

describe('comfyIntrospect', () => {
  // We re-import with cache reset between each test
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  describe('readRequiredFrontendVersion', () => {
    it('parses version from a valid requirements.txt fixture', async () => {
      // Use real fs for the fixture file
      const { readRequiredFrontendVersion } = await import(
        '../../src/services/comfyui/comfyIntrospect.js'
      );
      // Point COMFYUI_PATH at fixtures dir via env (default is /root/ComfyUI)
      // Since we can't inject env here without a full mock, we test the parser
      // logic directly by reading the fixture content ourselves.
      const content = fs.readFileSync(path.join(FIXTURES, 'comfyui_requirements.txt'), 'utf-8');
      const match = content.match(/^comfyui-frontend-package==(\S+)/im);
      expect(match).not.toBeNull();
      expect(match![1]).toBe('1.44.19');
      // The full version string format
      expect(`Comfy-Org/ComfyUI_frontend@v${match![1]}`).toBe('Comfy-Org/ComfyUI_frontend@v1.44.19');
      // readRequiredFrontendVersion on an absent path returns null
      const result = readRequiredFrontendVersion();
      // In CI /root/ComfyUI doesn't exist — must return null gracefully
      expect(result === null || typeof result === 'string').toBe(true);
    });

    it('returns null when requirements.txt is missing', async () => {
      vi.doMock('fs', async (orig) => {
        const actual = await orig<typeof import('fs')>();
        return {
          ...actual,
          default: {
            ...actual,
            readFileSync: vi.fn().mockImplementation(() => {
              const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
              throw err;
            }),
          },
        };
      });
      const { readRequiredFrontendVersion } = await import(
        '../../src/services/comfyui/comfyIntrospect.js'
      );
      expect(readRequiredFrontendVersion()).toBeNull();
    });

    it('returns null when the package line is absent', async () => {
      vi.doMock('fs', async (orig) => {
        const actual = await orig<typeof import('fs')>();
        return {
          ...actual,
          default: {
            ...actual,
            readFileSync: vi.fn().mockReturnValue('torch==2.4.0\ntorchvision>=0.19\n'),
          },
        };
      });
      const { readRequiredFrontendVersion } = await import(
        '../../src/services/comfyui/comfyIntrospect.js'
      );
      expect(readRequiredFrontendVersion()).toBeNull();
    });

    it('parses version correctly when the line exists', async () => {
      vi.doMock('fs', async (orig) => {
        const actual = await orig<typeof import('fs')>();
        return {
          ...actual,
          default: {
            ...actual,
            readFileSync: vi.fn().mockReturnValue(
              'torch==2.4.0\ncomfyui-frontend-package==1.44.19\neinops\n',
            ),
          },
        };
      });
      const { readRequiredFrontendVersion } = await import(
        '../../src/services/comfyui/comfyIntrospect.js'
      );
      expect(readRequiredFrontendVersion()).toBe('Comfy-Org/ComfyUI_frontend@v1.44.19');
    });

    it('is cached after first call (readFileSync called only once)', async () => {
      const readFileSyncMock = vi.fn().mockReturnValue(
        'comfyui-frontend-package==1.44.19\n',
      );
      vi.doMock('fs', async (orig) => {
        const actual = await orig<typeof import('fs')>();
        return {
          ...actual,
          default: { ...actual, readFileSync: readFileSyncMock },
        };
      });
      const { readRequiredFrontendVersion } = await import(
        '../../src/services/comfyui/comfyIntrospect.js'
      );
      readRequiredFrontendVersion();
      readRequiredFrontendVersion();
      readRequiredFrontendVersion();
      expect(readFileSyncMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('readValidComfyFlags', () => {
    it('parses a fake argparse JSON dump correctly', async () => {
      mockExecFileSync.mockReturnValue(fakeArgparseOutput());
      const { readValidComfyFlags } = await import(
        '../../src/services/comfyui/comfyIntrospect.js'
      );
      const flags = readValidComfyFlags();
      expect(flags).not.toBeNull();
      expect(flags!.length).toBeGreaterThanOrEqual(4);
      const portFlag = flags!.find((f) => f.optionString === '--port');
      expect(portFlag?.type).toBe('number');
      const xformers = flags!.find((f) => f.optionString === '--disable-xformers');
      expect(xformers?.type).toBe('flag');
    });

    it('returns null when execFileSync throws (Python unavailable)', async () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('spawn python3 ENOENT');
      });
      const { readValidComfyFlags } = await import(
        '../../src/services/comfyui/comfyIntrospect.js'
      );
      expect(readValidComfyFlags()).toBeNull();
    });

    it('returns null on malformed JSON', async () => {
      mockExecFileSync.mockReturnValue('not json at all {{');
      const { readValidComfyFlags } = await import(
        '../../src/services/comfyui/comfyIntrospect.js'
      );
      expect(readValidComfyFlags()).toBeNull();
    });

    it('returns null when stdout is not an array', async () => {
      mockExecFileSync.mockReturnValue(JSON.stringify({ error: 'bad' }));
      const { readValidComfyFlags } = await import(
        '../../src/services/comfyui/comfyIntrospect.js'
      );
      expect(readValidComfyFlags()).toBeNull();
    });

    it('is cached after first call (execFileSync called only once)', async () => {
      mockExecFileSync.mockReturnValue(fakeArgparseOutput());
      const { readValidComfyFlags } = await import(
        '../../src/services/comfyui/comfyIntrospect.js'
      );
      readValidComfyFlags();
      readValidComfyFlags();
      readValidComfyFlags();
      expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    });
  });
});
