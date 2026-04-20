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
  return { paths: { ...actual.paths, dataDir: TMP } };
});

const svc = await import('../../src/services/comfyui/launchOptions.service.js');

function cleanupConfig(): void {
  const p = path.join(TMP, 'comfyui-launch-options.json');
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
}

describe('launchOptions.service', () => {
  beforeEach(() => cleanupConfig());
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
});
