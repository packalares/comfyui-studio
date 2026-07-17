import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the DB repo and sidecar before importing the orchestrator.
vi.mock('../../src/lib/db/modelFiles.repo.js', () => ({
  listByFilename: vi.fn(),
  listBySha256: vi.fn(),
  findByDirAndName: vi.fn(),
}));

vi.mock('../../src/services/models/enrichment/sidecar.js', () => ({
  readSidecar: vi.fn().mockReturnValue(null),
}));

import { resolveOnDiskPresence } from '../../src/services/models/resolver/orchestrator.js';
import * as modelFiles from '../../src/lib/db/modelFiles.repo.js';

const mockListByFilename = modelFiles.listByFilename as ReturnType<typeof vi.fn>;
const mockListBySha256 = modelFiles.listBySha256 as ReturnType<typeof vi.fn>;
const mockFindByDirAndName = modelFiles.findByDirAndName as ReturnType<typeof vi.fn>;

function makeRow(overrides: object) {
  return {
    abs_path: '/models/checkpoints/model.safetensors',
    filename: 'model.safetensors',
    rel_path: 'checkpoints/model.safetensors',
    root_kind: 'local' as const,
    top_dir: 'checkpoints',
    size: 1000,
    status: 'complete',
    scanned_at: Date.now(),
    sha256: null,
    ...overrides,
  };
}

function makeWorkflow(filename: string, sha256?: string) {
  return {
    nodes: [{
      id: 1,
      type: 'CheckpointLoaderSimple',
      widgets_values: [filename],
      properties: {},
    }],
    ...(sha256 ? { extra: { Hashes: { [filename]: { sha256 } } } } : {}),
  };
}

beforeEach(() => {
  mockListByFilename.mockReset();
  mockListBySha256.mockReset();
  mockFindByDirAndName.mockReset();
  mockListByFilename.mockReturnValue([]);
  mockListBySha256.mockReturnValue([]);
  mockFindByDirAndName.mockReturnValue(null);
});

describe('resolveOnDiskPresence', () => {
  it('single basename match: resolves and rewrites workflow', async () => {
    const row = makeRow({ filename: 'flux1-dev.safetensors', top_dir: 'checkpoints' });
    mockListByFilename.mockReturnValue([row]);

    const result = await resolveOnDiskPresence(makeWorkflow('flux1-dev.safetensors'));

    expect(result.resolutions.has('flux1-dev.safetensors')).toBe(true);
    expect(result.chooserNeeded).toHaveLength(0);
    expect(result.missing).toHaveLength(0);

    const rw = result.rewrittenWorkflow as { nodes: Array<{ widgets_values: unknown[] }> };
    // save_path is 'checkpoints', so ComfyUI widget value is prefixed.
    expect(rw.nodes[0].widgets_values[0]).toBe('checkpoints/flux1-dev.safetensors');
  });

  it('no match: adds filename to missing', async () => {
    mockListByFilename.mockReturnValue([]);

    const result = await resolveOnDiskPresence(makeWorkflow('nonexistent.safetensors'));

    expect(result.missing).toContain('nonexistent.safetensors');
    expect(result.resolutions.size).toBe(0);
    expect(result.chooserNeeded).toHaveLength(0);
  });

  it('hash hint T1: resolves by sha256 when single row matches', async () => {
    const sha256 = 'a'.repeat(64);
    const row = makeRow({ filename: 'ae.safetensors', sha256 });
    mockListBySha256.mockReturnValue([row]);
    mockListByFilename.mockReturnValue([]);

    const result = await resolveOnDiskPresence(makeWorkflow('ae.safetensors', sha256));

    expect(result.resolutions.has('ae.safetensors')).toBe(true);
    expect(result.missing).toHaveLength(0);
  });

  it('3 collisions no hint: all go to chooserNeeded', async () => {
    const rows = [
      makeRow({ abs_path: '/models/a/ae.safetensors', top_dir: 'a' }),
      makeRow({ abs_path: '/models/b/ae.safetensors', top_dir: 'b' }),
      makeRow({ abs_path: '/models/c/ae.safetensors', top_dir: 'c' }),
    ];
    mockListByFilename.mockReturnValue(rows);

    const result = await resolveOnDiskPresence(makeWorkflow('ae.safetensors'));

    expect(result.chooserNeeded).toHaveLength(1);
    expect(result.chooserNeeded[0].filename).toBe('ae.safetensors');
    expect(result.chooserNeeded[0].candidates).toHaveLength(3);
    expect(result.resolutions.size).toBe(0);
  });

  it('caller-supplied chosenResolutions short-circuits all tiers', async () => {
    const result = await resolveOnDiskPresence(
      makeWorkflow('ae.safetensors'),
      { 'ae.safetensors': { save_path: 'flux', filename: 'ae.safetensors' } },
    );

    expect(result.resolutions.has('ae.safetensors')).toBe(true);
    expect(result.resolutions.get('ae.safetensors')?.save_path).toBe('flux');
    // DB should not have been consulted.
    expect(mockListByFilename).not.toHaveBeenCalled();
    expect(mockListBySha256).not.toHaveBeenCalled();
  });
});
