// Unit tests for Studio MCP tools against mocked services.
// Each tool's handler logic is exercised through a real McpServer instance
// using the in-process `Client` so the JSON-RPC framing is also verified.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// ---- mock services -------------------------------------------------------

vi.mock('../../../src/services/templates/index.js', () => ({}));

vi.mock('../../../src/services/templates/userTemplatesMeta.js', () => ({
  getUserTemplate: vi.fn(),
}));

vi.mock('../../../src/lib/db/templates.repo.js', () => ({
  listAllNames: vi.fn().mockReturnValue([]),
  getTemplate: vi.fn().mockReturnValue(null),
  listPaginated: vi.fn().mockReturnValue({ items: [], total: 0, hasMore: false, page: 1, pageSize: 100 }),
}));

vi.mock('../../../src/services/templates/dependencyCheck.js', () => ({
  checkTemplateDependencies: vi.fn(),
}));

vi.mock('../../../src/services/templates/submitTemplate.js', () => ({
  submitTemplate: vi.fn(),
}));

vi.mock('../../../src/services/comfyui/api.js', () => ({
  getQueuePromptIds: vi.fn(),
  getHistoryForPrompt: vi.fn(),
}));

vi.mock('../../../src/lib/db/gallery.repo.js', () => ({
  listAll: vi.fn().mockReturnValue([]),
  listByPromptIds: vi.fn().mockReturnValue([]),
}));

// ---- imports after mocks -------------------------------------------------

import { createStudioMcpServer } from '../../../src/services/mcp/server/index.js';
import * as userTemplatesMeta from '../../../src/services/templates/userTemplatesMeta.js';
import * as templateRepo from '../../../src/lib/db/templates.repo.js';
import * as depCheck from '../../../src/services/templates/dependencyCheck.js';
import * as submitMod from '../../../src/services/templates/submitTemplate.js';
import * as comfyui from '../../../src/services/comfyui/api.js';
import * as galleryRepo from '../../../src/lib/db/gallery.repo.js';
import type { TemplateData } from '../../../src/services/templates/types.js';

// ---- helpers -------------------------------------------------------------

async function makeClient() {
  const server = createStudioMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
  return { client };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const t = result.content.find(c => c.type === 'text');
  return t?.text ? JSON.parse(t.text) : null;
}

const FAKE_TEMPLATE: TemplateData = {
  name: 'sdxl-base',
  title: 'SDXL Base',
  description: 'Test template',
  mediaType: 'image',
  studioCategory: 'image',
  tags: ['test', 'sdxl'],
  models: ['sdxl.safetensors'],
  category: 'Image',
  io: { inputs: [], outputs: [] },
  thumbnail: [],
};

// ---- tests ---------------------------------------------------------------

describe('studio.listTemplates', () => {
  beforeEach(() => {
    vi.mocked(templateRepo.listPaginated).mockReturnValue({
      items: [{ ...FAKE_TEMPLATE, displayName: FAKE_TEMPLATE.title, updatedAt: 0, installed: false, favorite: false,
        source_type: 1, soft_deleted: 0, models: [], plugins: [], tags: [],
        thumbnail_json: null, media_type: 'image', open_source: 1, search_rank: 0, username: null }],
      total: 1, hasMore: false, page: 1, pageSize: 100,
    });
  });

  it('returns items array', async () => {
    const { client } = await makeClient();
    const result = await client.callTool({ name: 'studio.listTemplates', arguments: {} });
    const body = textOf(result as Parameters<typeof textOf>[0]);
    expect(body).toHaveProperty('items');
    expect(Array.isArray((body as { items: unknown[] }).items)).toBe(true);
  });

  it('filters by modality', async () => {
    // The tool passes modality as mediaType to listPaginated; the repo does the
    // filtering. Mock it to return only the video template (as the real repo would).
    vi.mocked(templateRepo.listPaginated).mockReturnValue({
      items: [
        { ...FAKE_TEMPLATE, name: 'vid', displayName: 'Vid', updatedAt: 0, installed: false, favorite: false,
          source_type: 1, soft_deleted: 0, models: [], plugins: [], tags: [],
          thumbnail_json: null, media_type: 'video', open_source: 1, search_rank: 0, username: null },
      ],
      total: 1, hasMore: false, page: 1, pageSize: 100,
    });
    const { client } = await makeClient();
    const result = await client.callTool({
      name: 'studio.listTemplates',
      arguments: { modality: 'video' },
    });
    const body = textOf(result as Parameters<typeof textOf>[0]) as { items: { name: string }[] };
    expect(body.items.length).toBe(1);
    expect(body.items[0].name).toBe('vid');
  });
});

describe('studio.describeTemplate', () => {
  it('returns error when template not found', async () => {
    vi.mocked(templateRepo.getTemplate).mockReturnValue(null);
    vi.mocked(userTemplatesMeta.getUserTemplate).mockReturnValue(null);
    const { client } = await makeClient();
    const result = await client.callTool({
      name: 'studio.describeTemplate',
      arguments: { name: 'nonexistent' },
    });
    const body = textOf(result as Parameters<typeof textOf>[0]) as { error?: string };
    expect(body).toHaveProperty('error');
  });

  it('returns full template data when found', async () => {
    const fakeRow = {
      ...FAKE_TEMPLATE, displayName: FAKE_TEMPLATE.title, updatedAt: 0, installed: false, favorite: false,
      source_type: 1, soft_deleted: 0, models: [], plugins: [], tags: [],
      thumbnail_json: null, media_type: 'image', open_source: 1, search_rank: 0, username: null,
    };
    vi.mocked(templateRepo.getTemplate).mockReturnValue(fakeRow);
    vi.mocked(userTemplatesMeta.getUserTemplate).mockReturnValue(FAKE_TEMPLATE);
    const { client } = await makeClient();
    const result = await client.callTool({
      name: 'studio.describeTemplate',
      arguments: { name: 'sdxl-base' },
    });
    const body = textOf(result as Parameters<typeof textOf>[0]) as { name: string };
    expect(body.name).toBe('sdxl-base');
  });
});

describe('studio.checkDependencies', () => {
  it('returns dependency result', async () => {
    vi.mocked(depCheck.checkTemplateDependencies).mockResolvedValue({
      ready: true, required: [], missing: [],
    });
    const { client } = await makeClient();
    const result = await client.callTool({
      name: 'studio.checkDependencies',
      arguments: { name: 'sdxl-base' },
    });
    const body = textOf(result as Parameters<typeof textOf>[0]) as { ready: boolean };
    expect(body.ready).toBe(true);
  });
});

describe('studio.submitGeneration', () => {
  it('returns promptId on success', async () => {
    vi.mocked(submitMod.submitTemplate).mockResolvedValue({
      promptId: 'abc-123',
      templateName: 'sdxl-base',
      fieldId: 'text',
    });
    const { client } = await makeClient();
    const result = await client.callTool({
      name: 'studio.submitGeneration',
      arguments: { templateName: 'sdxl-base', inputs: { prompt: 'a cat' } },
    });
    const body = textOf(result as Parameters<typeof textOf>[0]) as { promptId: string };
    expect(body.promptId).toBe('abc-123');
  });
});

describe('studio.getJobStatus', () => {
  it('reports running when in queue', async () => {
    vi.mocked(comfyui.getQueuePromptIds).mockResolvedValue(new Set(['pid-1']));
    const { client } = await makeClient();
    const result = await client.callTool({
      name: 'studio.getJobStatus',
      arguments: { promptId: 'pid-1' },
    });
    const body = textOf(result as Parameters<typeof textOf>[0]) as { state: string };
    expect(body.state).toBe('running');
  });

  it('reports done with gallery outputs when not in queue', async () => {
    vi.mocked(comfyui.getQueuePromptIds).mockResolvedValue(new Set());
    vi.mocked(comfyui.getHistoryForPrompt).mockResolvedValue({
      status: { messages: [] },
      outputs: {},
    });
    vi.mocked(galleryRepo.listByPromptIds).mockReturnValue([
      { id: 'x', filename: 'out.png', mediaType: 'image',
        url: '/api/view?filename=out.png', promptId: 'pid-2',
        subfolder: '', type: 'output', createdAt: 0 },
    ]);
    const { client } = await makeClient();
    const result = await client.callTool({
      name: 'studio.getJobStatus',
      arguments: { promptId: 'pid-2' },
    });
    const body = textOf(result as Parameters<typeof textOf>[0]) as {
      state: string; outputs: unknown[]
    };
    expect(body.state).toBe('done');
    expect(body.outputs.length).toBe(1);
  });
});

describe('studio.listRecentOutputs', () => {
  it('returns items from gallery', async () => {
    vi.mocked(galleryRepo.listAll).mockReturnValue([
      { id: 'y', filename: 'img.png', mediaType: 'image',
        url: '/api/view?filename=img.png', promptId: 'p1',
        subfolder: '', type: 'output', createdAt: 1000 },
    ]);
    const { client } = await makeClient();
    const result = await client.callTool({
      name: 'studio.listRecentOutputs',
      arguments: {},
    });
    const body = textOf(result as Parameters<typeof textOf>[0]) as { items: unknown[] };
    expect(body.items.length).toBe(1);
  });
});
