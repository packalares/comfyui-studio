// T6: URL validation in collectRequirements — malformed/private URLs must NOT
// be upserted into the catalog (audit G4).

import { describe, expect, it, vi, beforeEach } from 'vitest';

// Capture every call to catalog.upsertModel so we can assert what was or
// wasn't upserted.
const upsertCalls: Array<{ filename: string; url: string }> = [];
vi.mock('../../../src/services/catalog/index.js', () => ({
  upsertModel: (entry: { filename: string; url: string }) => {
    upsertCalls.push({ filename: entry.filename, url: entry.url });
    return entry;
  },
}));

// The dep-extract path is not exercised here — we only test collectRequirements.
vi.mock('../../../src/services/templates/depExtract.js', () => ({
  extractDeps: () => ({ models: [] }),
}));

const { collectRequirements } =
  await import('../../../src/services/templates/dependencyCheck.models.js');

// Minimal WorkflowNode fixture.
function nodeWithModel(name: string, url: string, dir?: string) {
  return {
    id: '1',
    type: 'SomeLoader',
    properties: {
      models: [{ name, url, directory: dir }],
    },
  };
}

describe('collectRequirements URL validation (audit G4)', () => {
  beforeEach(() => {
    upsertCalls.length = 0;
  });

  it('upserts a model with a valid public HTTPS URL', () => {
    collectRequirements(
      {},
      [nodeWithModel('model.safetensors', 'https://huggingface.co/x/y/resolve/main/model.safetensors', 'loras')],
      'test-template',
    );
    expect(upsertCalls.some(c => c.filename === 'model.safetensors')).toBe(true);
  });

  it('skips upsert for a file:// URL (non-http)', () => {
    collectRequirements(
      {},
      [nodeWithModel('evil.safetensors', 'file:///etc/passwd', 'loras')],
      'test-template',
    );
    expect(upsertCalls.some(c => c.filename === 'evil.safetensors')).toBe(false);
  });

  it('skips upsert for a loopback URL', () => {
    collectRequirements(
      {},
      [nodeWithModel('loopback.safetensors', 'http://127.0.0.1/bad.safetensors', 'loras')],
      'test-template',
    );
    expect(upsertCalls.some(c => c.filename === 'loopback.safetensors')).toBe(false);
  });

  it('skips upsert for a private IP URL', () => {
    collectRequirements(
      {},
      [nodeWithModel('private.safetensors', 'http://10.0.0.5/model.safetensors', 'loras')],
      'test-template',
    );
    expect(upsertCalls.some(c => c.filename === 'private.safetensors')).toBe(false);
  });

  it('skips upsert when url is missing (hfRepo-only entries are handled separately)', () => {
    const node = {
      id: '2',
      type: 'HFLoader',
      properties: {
        models: [{ name: 'repo-model', hfRepo: 'owner/repo', directory: 'loras' }],
      },
    };
    collectRequirements({}, [node], 'test-template');
    // hfRepo entries with no url are handled via repoEntries map, not upsert.
    expect(upsertCalls.some(c => c.filename === 'repo-model')).toBe(false);
  });
});
