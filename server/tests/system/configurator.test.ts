// Configurator URL validation + atomic-write persistence. Isolates the
// env-config file to a tmp dir so tests don't contaminate the developer's
// data directory.

import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'configurator-test-'));
process.env.DATA_DIR = tmpDir;

const configurator = await import('../../src/services/systemLauncher/configurator.service.js');
const liveSettings = await import('../../src/services/systemLauncher/liveSettings.js');

const envConfigPath = path.join(tmpDir, 'env-config.json');

function resetState(): void {
  try { fs.unlinkSync(envConfigPath); } catch { /* ignore */ }
  liveSettings.hydrate({ hfEndpoint: '', githubProxy: '', pipSource: '' });
}

describe('configurator URL validation', () => {
  beforeEach(() => resetState());
  afterAll(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('accepts https URL', () => {
    expect(configurator.validateUrl('https://hf-mirror.example.com/').ok).toBe(true);
  });

  it('rejects empty string', () => {
    expect(configurator.validateUrl('').ok).toBe(false);
  });

  it('rejects unparseable input', () => {
    expect(configurator.validateUrl('not a url').ok).toBe(false);
  });

  it('rejects ftp:// scheme', () => {
    expect(configurator.validateUrl('ftp://example.com/').ok).toBe(false);
  });

  it('rejects http:// for non-loopback hosts', () => {
    const r = configurator.validateUrl('http://example.com/');
    expect(r.ok).toBe(false);
  });

  it('accepts http://127.0.0.1 (loopback pip proxy)', () => {
    expect(configurator.validateUrl('http://127.0.0.1/pypi/simple/').ok).toBe(true);
  });

  it('accepts http://localhost', () => {
    expect(configurator.validateUrl('http://localhost:8080/').ok).toBe(true);
  });
});

describe('configurator setters', () => {
  beforeEach(() => resetState());
  afterAll(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('setPipSource writes to disk + updates liveSettings', () => {
    const r = configurator.setPipSource('https://pypi.example.com/simple/');
    expect(r.success).toBe(true);
    expect(liveSettings.getPipSource()).toBe('https://pypi.example.com/simple/');
    expect(fs.existsSync(envConfigPath)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(envConfigPath, 'utf8'));
    expect(saved.PIP_INDEX_URL).toBe('https://pypi.example.com/simple/');
  });

  it('setHuggingFaceEndpoint writes to disk + updates liveSettings', () => {
    const r = configurator.setHuggingFaceEndpoint('https://hf-mirror.example.com/');
    expect(r.success).toBe(true);
    expect(liveSettings.getHfEndpoint()).toBe('https://hf-mirror.example.com/');
    const saved = JSON.parse(fs.readFileSync(envConfigPath, 'utf8'));
    expect(saved.HF_ENDPOINT).toBe('https://hf-mirror.example.com/');
  });

  it('setGithubProxy writes to disk + updates liveSettings', () => {
    const r = configurator.setGithubProxy('https://ghp.example.com/');
    expect(r.success).toBe(true);
    expect(liveSettings.getGithubProxy()).toBe('https://ghp.example.com/');
    const saved = JSON.parse(fs.readFileSync(envConfigPath, 'utf8'));
    expect(saved.GITHUB_PROXY).toBe('https://ghp.example.com/');
  });

  it('rejects invalid URL without touching disk', () => {
    const r = configurator.setPipSource('not a url');
    expect(r.success).toBe(false);
    expect(liveSettings.getPipSource()).toBe('');
    // File may or may not exist from earlier setter calls in the suite, but
    // the value for PIP_INDEX_URL should not be present if we started clean.
    if (fs.existsSync(envConfigPath)) {
      const saved = JSON.parse(fs.readFileSync(envConfigPath, 'utf8'));
      expect(saved.PIP_INDEX_URL).toBeUndefined();
    }
  });

  it('loadPersisted rehydrates from disk', () => {
    fs.writeFileSync(envConfigPath, JSON.stringify({
      HF_ENDPOINT: 'https://hf.example.com/',
      GITHUB_PROXY: 'https://gh.example.com/',
      PIP_INDEX_URL: 'https://pypi.example.com/simple/',
    }));
    configurator.loadPersisted();
    expect(liveSettings.getHfEndpoint()).toBe('https://hf.example.com/');
    expect(liveSettings.getGithubProxy()).toBe('https://gh.example.com/');
    expect(liveSettings.getPipSource()).toBe('https://pypi.example.com/simple/');
  });

  it('multiple setters combine in a single file', () => {
    configurator.setPipSource('https://p.example.com/');
    configurator.setGithubProxy('https://g.example.com/');
    const saved = JSON.parse(fs.readFileSync(envConfigPath, 'utf8'));
    expect(saved.PIP_INDEX_URL).toBe('https://p.example.com/');
    expect(saved.GITHUB_PROXY).toBe('https://g.example.com/');
  });
});
