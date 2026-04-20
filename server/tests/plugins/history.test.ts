// Plugin operation history. Persistence via atomicWrite is exercised by the
// bundled data-dir resolution and verified by reading the file back.

import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Isolate the history file per test run. The service reads env.PLUGIN_HISTORY_PATH
// from config/env at import time (once); we override before any import below.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-history-test-'));
const tmpPath = path.join(tmpDir, 'history.json');
process.env.PLUGIN_HISTORY_PATH = tmpPath;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const history = await import('../../src/services/plugins/history.service.js');

function clearFile(): void {
  try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  history.clearHistory();
}

describe('plugin history service', () => {
  beforeEach(() => clearFile());
  afterAll(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('addHistoryItem persists to disk', () => {
    history.addHistoryItem('t1', 'foo', 'install', 'proxy.example.com');
    expect(fs.existsSync(tmpPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(tmpPath, 'utf-8'));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].id).toBe('t1');
    expect(parsed[0].pluginId).toBe('foo');
    expect(parsed[0].status).toBe('running');
  });

  it('updateHistoryItem mutates stored item', () => {
    history.addHistoryItem('t2', 'bar', 'install');
    history.updateHistoryItem('t2', { status: 'success', result: 'done', endTime: 123 });
    const items = history.getHistory();
    const found = items.find((i) => i.id === 't2');
    expect(found?.status).toBe('success');
    expect(found?.result).toBe('done');
    expect(found?.endTime).toBe(123);
  });

  it('appendLog grows the logs array', () => {
    history.addHistoryItem('t3', 'x', 'install');
    history.appendLog('t3', 'one');
    history.appendLog('t3', 'two');
    const item = history.getHistory().find((i) => i.id === 't3')!;
    expect(item.logs.length).toBeGreaterThanOrEqual(2);
    expect(item.logs.at(-1)).toContain('two');
  });

  it('deleteHistoryItem returns the removed entry', () => {
    history.addHistoryItem('t4', 'x', 'uninstall');
    const removed = history.deleteHistoryItem('t4');
    expect(removed?.id).toBe('t4');
    expect(history.getHistory().find((i) => i.id === 't4')).toBeUndefined();
  });

  it('deleteHistoryItem returns null for unknown id', () => {
    expect(history.deleteHistoryItem('nope')).toBeNull();
  });

  it('getLogs returns null for unknown task', () => {
    expect(history.getLogs('nope')).toBeNull();
  });

  it('clearHistory empties the file', () => {
    history.addHistoryItem('t5', 'y', 'install');
    history.clearHistory();
    const parsed = JSON.parse(fs.readFileSync(tmpPath, 'utf-8'));
    expect(parsed).toEqual([]);
  });
});
