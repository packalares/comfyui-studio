// Log service: accumulation, clearing, tail by KB.

import { describe, expect, it, beforeEach } from 'vitest';
import { LogService } from '../../src/services/comfyui/log.service.js';

describe('LogService', () => {
  let log: LogService;
  beforeEach(() => { log = new LogService(); });

  it('addLog accumulates entries with timestamp prefix', () => {
    log.addLog('hello');
    log.addLog('world');
    const lines = log.getRecentLogs();
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T/);
    expect(lines[0].endsWith('hello')).toBe(true);
  });

  it('addLog with isError prefixes ERROR', () => {
    log.addLog('oops', true);
    const lines = log.getRecentLogs();
    expect(lines[0].includes('ERROR: oops')).toBe(true);
  });

  it('clearLogs wipes the recent list', () => {
    log.addLog('x');
    log.clearLogs();
    expect(log.getRecentLogs()).toEqual([]);
  });

  it('tail returns last lines within byte budget', () => {
    for (let i = 0; i < 10; i++) log.addLog(`entry-${i}`);
    const t = log.tail(1); // 1 KB budget — all short lines should fit.
    expect(t.length).toBe(10);
    expect(t[t.length - 1].includes('entry-9')).toBe(true);
  });

  it('tail trims old entries when budget is small', () => {
    for (let i = 0; i < 100; i++) log.addLog(`x-${i}-${'.'.repeat(200)}`);
    const t = log.tail(1); // 1 KB budget forces trimming.
    expect(t.length).toBeLessThan(100);
    // Whatever is returned ends with the most recent entries.
    expect(t[t.length - 1].includes('x-99')).toBe(true);
  });

  it('reset logs are independent from regular logs', () => {
    log.addLog('regular');
    log.addResetLog('reset-event');
    expect(log.getRecentLogs().length).toBe(1);
    expect(log.getResetLogs().length).toBe(1);
  });
});
