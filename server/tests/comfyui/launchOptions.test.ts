// Launch-options service: defaults + PUT merge + reset restores defaults.
// We override the paths module with a temp dir so the test never touches
// user state and works regardless of env eval order.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-launch-opts-'));

vi.mock('../../src/config/paths.js', async (orig) => {
  const actual = (await orig()) as { paths: Record<string, unknown> };
  return {
    paths: {
      ...actual.paths,
      dataDir: TMP,
      launchOptionsPath: path.join(TMP, 'comfyui-launch-options.json'),
    },
  };
});

// Default mock: introspection not available (null fallback path)
vi.mock('../../src/services/comfyui/comfyIntrospect.js', () => ({
  readRequiredFrontendVersion: vi.fn(() => null),
  readValidComfyFlags: vi.fn(() => null),
  _resetIntrospectCache: vi.fn(),
}));

import * as introspect from '../../src/services/comfyui/comfyIntrospect.js';
const mockFrontendVersion = vi.mocked(introspect.readRequiredFrontendVersion);
const mockValidFlags = vi.mocked(introspect.readValidComfyFlags);

const svc = await import('../../src/services/comfyui/launchOptions.js');

function cleanupConfig(): void {
  const p = path.join(TMP, 'comfyui-launch-options.json');
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
}

describe('launchOptions.service', () => {
  beforeEach(() => {
    cleanupConfig();
    // Reset to default mock state (introspection unavailable)
    mockFrontendVersion.mockReturnValue(null);
    mockValidFlags.mockReturnValue(null);
  });
  afterEach(() => cleanupConfig());

  it('getDefaultConfig returns a populated config', () => {
    const cfg = svc.getDefaultConfig();
    expect(cfg.items.length).toBeGreaterThan(50);
    const port = cfg.items.find((i) => i.key === '--port');
    expect(port?.readOnly).toBe(true);
    const frontEnd = cfg.items.find((i) => i.key === '--front-end-version');
    expect(frontEnd?.readOnly).toBe(true);
  });

  it('readConfig seeds a fresh file with defaults', () => {
    const cfg = svc.readConfig();
    expect(cfg.items.length).toBeGreaterThan(50);
    expect(fs.existsSync(path.join(TMP, 'comfyui-launch-options.json'))).toBe(true);
  });

  it('updateLaunchOptions merges a partial payload', () => {
    const current = svc.readConfig();
    const withOne = current.items.map((i) =>
      i.key === '--lowvram' ? { ...i, enabled: true } : i,
    );
    const merged = svc.updateLaunchOptions({ mode: 'list', items: withOne });
    const lowvram = merged.items.find((i) => i.key === '--lowvram');
    expect(lowvram?.enabled).toBe(true);
  });

  it('resetToDefault restores defaults', () => {
    const current = svc.readConfig();
    const items = current.items.map((i) =>
      i.key === '--lowvram' ? { ...i, enabled: true } : i,
    );
    svc.updateLaunchOptions({ mode: 'list', items });
    const reset = svc.resetToDefault();
    const lowvram = reset.items.find((i) => i.key === '--lowvram');
    expect(lowvram?.enabled).toBe(false);
  });

  it('getLaunchCommandView omits --port / --front-end-version from extraArgs', () => {
    const view = svc.getLaunchCommandView();
    expect(view.extraArgs.includes('--port')).toBe(false);
    expect(view.baseCommand).toBe('python3 ./ComfyUI/main.py');
    expect(view.fixedArgs[0]).toBe('--listen');
    expect(view.fixedArgs[1]).toBe('--port');
  });

  it('buildCliArgsString returns extra args only', () => {
    const str = svc.buildCliArgsString();
    expect(str.includes('--listen')).toBe(false);
    expect(str.includes('--port ')).toBe(false);
  });

  // ---- New scenarios ----

  describe('stale flag removal', () => {
    it('drops --normalvram from launch args when introspection returns null (static deny-list fallback)', () => {
      mockValidFlags.mockReturnValue(null);
      // Build a config with --normalvram enabled (simulating a stale JSON on disk)
      const cfg = svc.readConfig();
      const withStaleFlag = cfg.items.concat([{
        key: '--normalvram',
        enabled: true,
        type: 'flag',
        description: 'stale flag',
        category: 'vram',
        order: 9999,
      }]);
      const builtArgs = svc.buildExtraArgsArray({ mode: 'list', items: withStaleFlag });
      const filtered = svc.filterInvalidFlags(builtArgs);
      expect(filtered.includes('--normalvram')).toBe(false);
    });

    it('drops flag not in argparse set when live flags are present', () => {
      // Only these flags are "valid" per argparse
      mockValidFlags.mockReturnValue([
        { optionString: '--disable-xformers', type: 'flag', help: '' },
        { optionString: '--lowvram', type: 'flag', help: '' },
      ]);
      const tokens = ['--disable-xformers', '--normalvram', '--lowvram'];
      const filtered = svc.filterInvalidFlags(tokens);
      expect(filtered).toContain('--disable-xformers');
      expect(filtered).toContain('--lowvram');
      expect(filtered).not.toContain('--normalvram');
    });
  });

  describe('frontend version derivation', () => {
    it('falls back to hardcoded default when readRequiredFrontendVersion returns null', () => {
      mockFrontendVersion.mockReturnValue(null);
      const version = svc.getDefaultFrontendVersion();
      // Should fall back to either env CLI_ARGS parse or hardcoded constant
      expect(typeof version).toBe('string');
      expect(version.startsWith('Comfy-Org/')).toBe(true);
    });

    it('uses the version from requirements.txt when available', () => {
      mockFrontendVersion.mockReturnValue('Comfy-Org/ComfyUI_frontend@v1.44.19');
      const version = svc.getDefaultFrontendVersion();
      expect(version).toBe('Comfy-Org/ComfyUI_frontend@v1.44.19');
    });

    it('system-managed --front-end-version always reflects derived value, ignoring JSON', () => {
      mockFrontendVersion.mockReturnValue('Comfy-Org/ComfyUI_frontend@v1.44.19');
      // Write a config to disk with a stale frontend version
      const staleConfig = {
        mode: 'list' as const,
        items: [{
          key: '--front-end-version',
          value: 'Comfy-Org/ComfyUI_frontend@v1.0.0',
          enabled: true,
          type: 'string' as const,
          description: 'Frontend version',
          category: 'network',
          order: 2,
          readOnly: true,
        }],
        manualArgs: '',
      };
      fs.writeFileSync(
        path.join(TMP, 'comfyui-launch-options.json'),
        JSON.stringify(staleConfig, null, 2),
      );
      const cfg = svc.readConfig();
      const frontEndItem = cfg.items.find((i) => i.key === '--front-end-version');
      // The normalizeItem call enforces the derived value for readOnly items
      expect(frontEndItem?.value).toBe('Comfy-Org/ComfyUI_frontend@v1.44.19');
    });
  });

  describe('discovered flags injection', () => {
    it('injects a future flag not in curated metadata with category discovered', () => {
      mockValidFlags.mockReturnValue([
        { optionString: '--disable-xformers', type: 'flag', help: 'disable xformers' },
        { optionString: '--lowvram', type: 'flag', help: 'low vram' },
        { optionString: '--some-future-flag', type: 'flag', help: 'a new flag' },
        { optionString: '--another-new-flag', type: 'string', help: 'another new flag', defaultValue: 'default' },
      ]);
      const items = svc.buildDefaultItems();
      const discovered = items.filter((i) => i.category === 'discovered');
      expect(discovered.some((i) => i.key === '--some-future-flag')).toBe(true);
      expect(discovered.some((i) => i.key === '--another-new-flag')).toBe(true);
      // Discovered items must NOT overlap with curated items
      expect(items.find((i) => i.key === '--disable-xformers')?.category).not.toBe('discovered');
    });

    it('discovered flags have enabled: false and high order values', () => {
      mockValidFlags.mockReturnValue([
        { optionString: '--some-future-flag', type: 'flag', help: 'a new flag' },
      ]);
      const items = svc.buildDefaultItems();
      const fut = items.find((i) => i.key === '--some-future-flag');
      expect(fut).toBeDefined();
      expect(fut?.enabled).toBe(false);
      expect(fut?.order).toBeGreaterThanOrEqual(1000);
    });

    it('returns no discovered items when introspection is unavailable', () => {
      mockValidFlags.mockReturnValue(null);
      const items = svc.buildDefaultItems();
      const discovered = items.filter((i) => i.category === 'discovered');
      expect(discovered.length).toBe(0);
    });
  });

  describe('fallback when introspection fails', () => {
    it('still boots and returns items when readValidComfyFlags returns null', () => {
      mockValidFlags.mockReturnValue(null);
      const cfg = svc.getDefaultConfig();
      expect(cfg.items.length).toBeGreaterThan(50);
    });

    it('still boots and returns items when readRequiredFrontendVersion returns null', () => {
      mockFrontendVersion.mockReturnValue(null);
      const cfg = svc.getDefaultConfig();
      const frontEnd = cfg.items.find((i) => i.key === '--front-end-version');
      expect(frontEnd).toBeDefined();
      // Falls back to hardcoded — still a valid Comfy-Org string
      expect(String(frontEnd?.value)).toContain('Comfy-Org/');
    });
  });

  describe('user-editable values preserved', () => {
    it('keeps user-enabled --lowvram in JSON after read', () => {
      const cfg = svc.readConfig();
      const items = cfg.items.map((i) =>
        i.key === '--lowvram' ? { ...i, enabled: true } : i,
      );
      svc.updateLaunchOptions({ mode: 'list', items });
      const reread = svc.readConfig();
      const lowvram = reread.items.find((i) => i.key === '--lowvram');
      expect(lowvram?.enabled).toBe(true);
    });
  });
});
