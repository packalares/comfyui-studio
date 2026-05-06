// Tests for the 10 MCP comfy tool implementations.
// All network / filesystem calls are mocked via vi.mock.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---- mock _lib/comfyClient ----
vi.mock('../../src/services/mcp/server/tools/comfy/_lib/comfyClient.js', () => ({
  getSystemStats: vi.fn(),
  getObjectInfo: vi.fn(),
  postFree: vi.fn(),
  ComfyUIHttpError: class ComfyUIHttpError extends Error {
    status: number; body: string; path: string;
    constructor(status: number, statusText: string, path: string, body: string) {
      super(`${status} ${statusText}`);
      this.status = status; this.body = body; this.path = path;
    }
  },
}));

// ---- mock _lib/registryClient ----
vi.mock('../../src/services/mcp/server/tools/comfy/_lib/registryClient.js', () => ({
  searchNodes: vi.fn(),
  getNodePackDetails: vi.fn(),
}));

// ---- mock _lib/hfSearch ----
vi.mock('../../src/services/mcp/server/tools/comfy/_lib/hfSearch.js', () => ({
  searchHuggingFaceModels: vi.fn(),
}));

// ---- mock fs/promises for workflowFromImage ----
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

import * as comfyClient from '../../src/services/mcp/server/tools/comfy/_lib/comfyClient.js';
import * as registryClient from '../../src/services/mcp/server/tools/comfy/_lib/registryClient.js';
import * as hfSearch from '../../src/services/mcp/server/tools/comfy/_lib/hfSearch.js';
import * as fs from 'node:fs/promises';

import { getNodeInfo } from '../../src/services/mcp/server/tools/comfy/getNodeInfo.js';
import { searchModels } from '../../src/services/mcp/server/tools/comfy/searchModels.js';
import { searchCustomNodes } from '../../src/services/mcp/server/tools/comfy/searchCustomNodes.js';
import { getNodePackDetails } from '../../src/services/mcp/server/tools/comfy/getNodePackDetails.js';
import { getSystemStats } from '../../src/services/mcp/server/tools/comfy/getSystemStats.js';
import { clearVram } from '../../src/services/mcp/server/tools/comfy/clearVram.js';
import { workflowFromImage } from '../../src/services/mcp/server/tools/comfy/workflowFromImage.js';
import { visualizeWorkflow } from '../../src/services/mcp/server/tools/comfy/visualizeWorkflow.js';
import { validateWorkflow } from '../../src/services/mcp/server/tools/comfy/validateWorkflow.js';
import { analyzeWorkflow } from '../../src/services/mcp/server/tools/comfy/analyzeWorkflow.js';

const mockGetObjectInfo = comfyClient.getObjectInfo as ReturnType<typeof vi.fn>;
const mockGetSystemStats = comfyClient.getSystemStats as ReturnType<typeof vi.fn>;
const mockPostFree = comfyClient.postFree as ReturnType<typeof vi.fn>;
const mockSearchNodes = registryClient.searchNodes as ReturnType<typeof vi.fn>;
const mockGetNodePack = registryClient.getNodePackDetails as ReturnType<typeof vi.fn>;
const mockSearchHF = hfSearch.searchHuggingFaceModels as ReturnType<typeof vi.fn>;
const mockReadFile = fs.readFile as ReturnType<typeof vi.fn>;

beforeEach(() => { vi.clearAllMocks(); });

const SIMPLE_WORKFLOW = {
  '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'v1-5.safetensors' } },
  '2': { class_type: 'CLIPTextEncode', inputs: { text: 'cat', clip: ['1', 1] } },
  '3': { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['2', 0], negative: ['2', 0], latent_image: ['4', 0], seed: 42, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1 } },
  '4': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
  '5': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['1', 2] } },
  '6': { class_type: 'SaveImage', inputs: { images: ['5', 0], filename_prefix: 'out' } },
};

// ---- getNodeInfo ----
describe('getNodeInfo', () => {
  it('returns summary for large result sets', async () => {
    const bigInfo: Record<string, unknown> = {};
    for (let i = 0; i < 30; i++) bigInfo[`Node${i}`] = { display_name: `Node${i}`, category: 'test', description: '' };
    mockGetObjectInfo.mockResolvedValueOnce(bigInfo);
    const res = await getNodeInfo({});
    expect(res.error).toBeUndefined();
    const parsed = JSON.parse(res.text);
    expect(parsed.count).toBe(30);
    expect(parsed.hint).toMatch(/filter/);
  });

  it('returns full definitions for <= 20 matches', async () => {
    mockGetObjectInfo.mockResolvedValueOnce({
      KSampler: { input: { required: { seed: ['INT'] } }, output: ['LATENT'], display_name: 'KSampler', category: 'sampling', description: '' },
    });
    const res = await getNodeInfo({ node_type: 'KSampler' });
    expect(res.error).toBeUndefined();
    expect(res.text).toContain('KSampler');
  });

  it('propagates errors', async () => {
    mockGetObjectInfo.mockRejectedValueOnce(new Error('timeout'));
    const res = await getNodeInfo({});
    expect(res.error).toBeDefined();
  });
});

// ---- searchModels ----
describe('searchModels', () => {
  it('formats results correctly', async () => {
    mockSearchHF.mockResolvedValueOnce([
      { id: 'a/b', modelId: 'a/b', author: 'alice', tags: ['t2i'], downloads: 1000, likes: 5, lastModified: '' },
    ]);
    const res = await searchModels({ query: 'flux' });
    expect(res.error).toBeUndefined();
    expect(res.text).toContain('a/b');
    expect(res.text).toContain('alice');
  });

  it('returns no-results message on empty', async () => {
    mockSearchHF.mockResolvedValueOnce([]);
    const res = await searchModels({ query: 'nothing' });
    expect(res.text).toMatch(/No models found/);
  });

  it('propagates errors', async () => {
    mockSearchHF.mockRejectedValueOnce(new Error('network error'));
    const res = await searchModels({ query: 'x' });
    expect(res.error).toBeDefined();
  });
});

// ---- searchCustomNodes ----
describe('searchCustomNodes', () => {
  it('formats results correctly', async () => {
    mockSearchNodes.mockResolvedValueOnce([
      { id: 'impact-pack', name: 'ComfyUI Impact Pack', description: 'Useful', author: 'ltdrdata', repository: '', latest_version: '7.0', total_install: 99000 },
    ]);
    const res = await searchCustomNodes({ query: 'impact' });
    expect(res.error).toBeUndefined();
    expect(res.text).toContain('impact-pack');
  });

  it('returns no-results on empty', async () => {
    mockSearchNodes.mockResolvedValueOnce([]);
    const res = await searchCustomNodes({ query: 'xyz' });
    expect(res.text).toMatch(/No custom nodes found/);
  });

  it('propagates errors', async () => {
    mockSearchNodes.mockRejectedValueOnce(new Error('api down'));
    const res = await searchCustomNodes({ query: 'x' });
    expect(res.error).toBeDefined();
  });
});

// ---- getNodePackDetails ----
describe('getNodePackDetails', () => {
  it('formats pack details', async () => {
    mockGetNodePack.mockResolvedValueOnce({
      id: 'impact-pack', name: 'ComfyUI Impact Pack', description: 'desc', author: 'lt',
      repository: 'https://github.com/lt/impact', latest_version: '7', total_install: 50000,
      tags: [], license: 'MIT', created_at: '2023-01-01', updated_at: '2024-01-01',
      nodes: ['SAMDetectorCombined'], versions: [{ version: '7.0' }],
    });
    const res = await getNodePackDetails({ id: 'impact-pack' });
    expect(res.error).toBeUndefined();
    expect(res.text).toContain('ComfyUI Impact Pack');
    expect(res.text).toContain('SAMDetectorCombined');
  });

  it('propagates errors', async () => {
    mockGetNodePack.mockRejectedValueOnce(new Error('not found'));
    const res = await getNodePackDetails({ id: 'bad-id' });
    expect(res.error).toBeDefined();
  });
});

// ---- getSystemStats ----
describe('getSystemStats', () => {
  it('returns JSON stats', async () => {
    const fakeStats = { system: { os: 'linux', python_version: '3.11', embedded_python: false }, devices: [] };
    mockGetSystemStats.mockResolvedValueOnce(fakeStats);
    const res = await getSystemStats();
    expect(res.error).toBeUndefined();
    const parsed = JSON.parse(res.text);
    expect(parsed.system.os).toBe('linux');
  });

  it('propagates errors', async () => {
    mockGetSystemStats.mockRejectedValueOnce(new Error('unreachable'));
    const res = await getSystemStats();
    expect(res.error).toBeDefined();
  });
});

// ---- clearVram ----
describe('clearVram', () => {
  it('happy path with stats', async () => {
    mockPostFree.mockResolvedValueOnce({ ok: true });
    mockGetSystemStats.mockResolvedValueOnce({
      system: {}, devices: [{ name: 'RTX4090', type: 'cuda', index: 0, vram_total: 24 * 1024 * 1024 * 1024, vram_free: 20 * 1024 * 1024 * 1024, torch_vram_total: 24 * 1024 * 1024 * 1024, torch_vram_free: 20 * 1024 * 1024 * 1024 }],
    });
    const res = await clearVram({});
    expect(res.error).toBeUndefined();
    expect(res.text).toContain('VRAM cleared');
    expect(res.text).toContain('VRAM:');
  });

  it('returns error message on non-ok response', async () => {
    mockPostFree.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Internal Server Error', text: async () => '' });
    const res = await clearVram({ unload_models: true, free_memory: false });
    expect(res.error).toBeDefined();
    expect(res.text).toContain('Failed to free VRAM');
  });

  it('propagates fetch errors', async () => {
    mockPostFree.mockRejectedValueOnce(new Error('connection refused'));
    const res = await clearVram({});
    expect(res.error).toBeDefined();
  });
});

// ---- workflowFromImage ----
describe('workflowFromImage', () => {
  function makePngWithTextChunk(keyword: string, text: string): Buffer {
    const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const kwBuf = Buffer.from(keyword, 'latin1');
    const nullByte = Buffer.from([0]);
    const textBuf = Buffer.from(text, 'latin1');
    const data = Buffer.concat([kwBuf, nullByte, textBuf]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const type = Buffer.from('tEXt', 'ascii');
    const crc = Buffer.alloc(4);
    const chunk = Buffer.concat([len, type, data, crc]);
    const iend = Buffer.concat([Buffer.alloc(4), Buffer.from('IEND', 'ascii'), Buffer.alloc(4)]);
    return Buffer.concat([sig, chunk, iend]);
  }

  it('extracts workflow from PNG tEXt chunk', async () => {
    const wf = { '1': { class_type: 'KSampler', inputs: {} } };
    const buf = makePngWithTextChunk('prompt', JSON.stringify(wf));
    mockReadFile.mockResolvedValueOnce(buf);
    const res = await workflowFromImage({ image_path: '/tmp/test.png' });
    expect(res.error).toBeUndefined();
    expect(res.text).toContain('KSampler');
  });

  it('returns error for non-PNG files', async () => {
    const res = await workflowFromImage({ image_path: '/tmp/test.jpg' });
    expect(res.error).toBeDefined();
    expect(res.text).toContain('PNG');
  });

  it('propagates fs errors', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));
    const res = await workflowFromImage({ image_path: '/tmp/missing.png' });
    expect(res.error).toBeDefined();
  });
});

// ---- visualizeWorkflow ----
describe('visualizeWorkflow', () => {
  it('returns mermaid diagram', async () => {
    const res = await visualizeWorkflow({ workflow: SIMPLE_WORKFLOW });
    expect(res.error).toBeUndefined();
    expect(res.text).toContain('```mermaid');
    expect(res.text).toContain('flowchart LR');
  });

  it('accepts JSON string input', async () => {
    const res = await visualizeWorkflow({ workflow: JSON.stringify(SIMPLE_WORKFLOW) });
    expect(res.error).toBeUndefined();
    expect(res.text).toContain('flowchart');
  });

  it('returns error on empty workflow', async () => {
    const res = await visualizeWorkflow({ workflow: {} });
    expect(res.error).toBeDefined();
  });

  it('returns error on invalid JSON string', async () => {
    const res = await visualizeWorkflow({ workflow: 'not json' });
    expect(res.error).toBeDefined();
  });
});

// ---- validateWorkflow ----
describe('validateWorkflow', () => {
  it('validates valid workflow', async () => {
    mockGetObjectInfo.mockResolvedValueOnce({
      CheckpointLoaderSimple: { input: { required: { ckpt_name: [['v1-5.safetensors']] } }, output: ['MODEL','CLIP','VAE'], output_node: false },
      CLIPTextEncode: { input: { required: { text: ['STRING'], clip: ['CLIP'] } }, output: ['CONDITIONING'], output_node: false },
      KSampler: { input: { required: { model: ['MODEL'], positive: ['CONDITIONING'], negative: ['CONDITIONING'], latent_image: ['LATENT'], seed: ['INT'], steps: ['INT'], cfg: ['FLOAT'], sampler_name: [['euler']], scheduler: [['normal']], denoise: ['FLOAT'] } }, output: ['LATENT'], output_node: false },
      EmptyLatentImage: { input: { required: { width: ['INT'], height: ['INT'], batch_size: ['INT'] } }, output: ['LATENT'], output_node: false },
      VAEDecode: { input: { required: { samples: ['LATENT'], vae: ['VAE'] } }, output: ['IMAGE'], output_node: false },
      SaveImage: { input: { required: { images: ['IMAGE'], filename_prefix: ['STRING'] } }, output: [], output_node: true },
    });
    const res = await validateWorkflow({ workflow: SIMPLE_WORKFLOW });
    expect(res.error).toBeUndefined();
    expect(res.valid).toBe(true);
    expect(res.text).toContain('valid');
  });

  it('reports unknown node types', async () => {
    mockGetObjectInfo.mockResolvedValueOnce({});
    const res = await validateWorkflow({ workflow: { '1': { class_type: 'UnknownNode', inputs: {} } } });
    expect(res.valid).toBe(false);
    expect(res.text).toContain('Unknown node type');
  });

  it('handles ComfyUI unreachable', async () => {
    mockGetObjectInfo.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const res = await validateWorkflow({ workflow: SIMPLE_WORKFLOW });
    expect(res.valid).toBe(false);
    expect(res.text).toContain('cannot reach ComfyUI');
  });
});

// ---- analyzeWorkflow ----
describe('analyzeWorkflow', () => {
  it('returns summary by default', async () => {
    const res = await analyzeWorkflow({ workflow: SIMPLE_WORKFLOW });
    expect(res.error).toBeUndefined();
    expect(res.text).toContain('Node Types');
    expect(res.text).toContain('KSampler');
  });

  it('returns mermaid for flat view', async () => {
    const res = await analyzeWorkflow({ workflow: SIMPLE_WORKFLOW, view: 'flat' });
    expect(res.error).toBeUndefined();
    expect(res.text).toContain('```mermaid');
  });

  it('returns error on empty workflow', async () => {
    const res = await analyzeWorkflow({ workflow: {} });
    expect(res.error).toBeDefined();
  });
});
