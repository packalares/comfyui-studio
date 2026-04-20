// Network checker orchestration + log persistence. The curl subprocess is
// real (invoked via lib/exec.run with a tight timeout) so tests target a
// short-lived bogus URL that resolves to nothing; what we verify here is
// the orchestration shape, id validation, and log write path — not the
// probe's network outcome.

import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netcheck-test-'));

const logs = await import('../../src/services/systemLauncher/networkChecker/logs.js');
const svc = await import('../../src/services/systemLauncher/networkChecker/service.js');

logs.__setDirForTests(tmpDir);

describe('networkChecker log id validation', () => {
  it('accepts uuid-like ids', () => {
    expect(logs.isValidId('5f9b1e7c-1234-4abc-9def-0123456789ab')).toBe(true);
  });

  it('accepts alphanumeric + . _ -', () => {
    expect(logs.isValidId('abc.DEF_123-xyz')).toBe(true);
  });

  it('rejects path-traversal attempts', () => {
    expect(logs.isValidId('../etc/passwd')).toBe(false);
    expect(logs.isValidId('foo/bar')).toBe(false);
    expect(logs.isValidId('foo\\bar')).toBe(false);
  });

  it('rejects empty and oversize ids', () => {
    expect(logs.isValidId('')).toBe(false);
    expect(logs.isValidId('a'.repeat(200))).toBe(false);
  });
});

describe('networkChecker log persistence', () => {
  beforeEach(() => { svc.__resetForTests(); });
  afterAll(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('createLog writes an initial file to disk', () => {
    logs.createLog('test-1');
    const file = path.join(tmpDir, 'test-1.json');
    expect(fs.existsSync(file)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(parsed.id).toBe('test-1');
    expect(parsed.status).toBe('in_progress');
    expect(Array.isArray(parsed.logs)).toBe(true);
  });

  it('appendEntry updates the file', () => {
    logs.createLog('test-2');
    logs.appendEntry('test-2', 'hello world', 'info');
    const parsed = JSON.parse(fs.readFileSync(path.join(tmpDir, 'test-2.json'), 'utf8'));
    expect(parsed.logs[0].message).toBe('hello world');
    expect(parsed.logs[0].type).toBe('info');
  });

  it('completeLog sets status + result + endTime', () => {
    logs.createLog('test-3');
    logs.completeLog('test-3', {
      github: { accessible: true, url: 'https://github.com/' },
      pip: { accessible: true, url: 'https://pypi.org/simple/' },
      huggingface: { accessible: false, url: 'https://huggingface.co/' },
    });
    const parsed = JSON.parse(fs.readFileSync(path.join(tmpDir, 'test-3.json'), 'utf8'));
    expect(parsed.status).toBe('completed');
    expect(parsed.endTime).toBeGreaterThan(0);
    expect(parsed.result.github.accessible).toBe(true);
  });

  it('failLog records failure status', () => {
    logs.createLog('test-4');
    logs.failLog('test-4', 'boom');
    const parsed = JSON.parse(fs.readFileSync(path.join(tmpDir, 'test-4.json'), 'utf8'));
    expect(parsed.status).toBe('failed');
    expect(parsed.logs.find((l: { message: string }) => l.message === 'boom')).toBeDefined();
  });

  it('getLog returns null for unknown ids', () => {
    expect(logs.getLog('never-created')).toBeNull();
  });

  it('getLog retrieves a log even after in-memory eviction', () => {
    // Force eviction: create 12 logs (MAX_IN_MEMORY=10).
    for (let i = 0; i < 12; i++) logs.createLog(`evict-${i}`);
    const first = logs.getLog('evict-0');
    expect(first).not.toBeNull();
    expect(first?.id).toBe('evict-0');
  });
});

describe('networkChecker triggerCheck', () => {
  beforeEach(() => { svc.__resetForTests(); });

  it('returns a checkId and in_progress status', () => {
    const r = svc.triggerCheck();
    expect(typeof r.checkId).toBe('string');
    expect(r.checkId.length).toBeGreaterThan(0);
    expect(r.status).toBe('in_progress');
  });

  it('produces a retrievable in-progress log immediately', () => {
    const r = svc.triggerCheck();
    const log = svc.getLog(r.checkId);
    expect(log).not.toBeNull();
    expect(log?.status).toBe('in_progress');
  });

  it('rejects malformed ids when fetching logs', () => {
    expect(svc.getLog('../../etc/passwd')).toBeNull();
    expect(svc.getLog('')).toBeNull();
  });
});
