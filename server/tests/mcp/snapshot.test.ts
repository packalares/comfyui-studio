// Profile filtering correctness tests for snapshot().

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Profile } from '../../src/services/settings.mcp.js';
import type { StudioTool } from '../../src/services/chat/tools/defineTool.js';

// ---- Minimal StudioTool stub -----------------------------------------------

function stubTool(name: string): StudioTool {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tool: { description: name, inputSchema: {} as any, execute: async () => undefined } as any,
    unloadGpuOnUse: false,
  };
}

// ---- Mock registry ---------------------------------------------------------

const allTools: Record<string, StudioTool> = {
  'mcp__server-a__search': stubTool('search'),
  'mcp__server-a__fetch': stubTool('fetch'),
  'mcp__server-b__summarize': stubTool('summarize'),
  'mcp__server-b__embed': stubTool('embed'),
};

vi.mock('../../src/services/mcp/client/index.js', () => ({
  getRegistry: () => ({
    getAllTools: vi.fn().mockResolvedValue(allTools),
  }),
}));

// ---- Mock settings (profiles) ---------------------------------------------

let mockProfiles: Record<string, Profile> = {};

vi.mock('../../src/services/settings.mcp.js', () => ({
  getMcpProfiles: () => mockProfiles,
  DEFAULT_PROFILE_NAME: 'studio-chat-default',
}));

// Import AFTER mocks
const { snapshot } = await import('../../src/services/mcp/client/snapshot.js');

// ---- Tests ----------------------------------------------------------------

describe('snapshot()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProfiles = { 'studio-chat-default': {} };
  });

  it('returns empty map for empty default profile', async () => {
    mockProfiles = { 'studio-chat-default': {} };
    const result = await snapshot('studio-chat-default');
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('returns all tools for a server when entry is "*"', async () => {
    mockProfiles = {
      'studio-chat-default': { 'server-a': '*' },
    };
    const result = await snapshot('studio-chat-default');
    expect(Object.keys(result)).toContain('mcp__server-a__search');
    expect(Object.keys(result)).toContain('mcp__server-a__fetch');
    expect(Object.keys(result)).not.toContain('mcp__server-b__summarize');
  });

  it('returns only allowed tools when entry is string[]', async () => {
    mockProfiles = {
      'my-profile': { 'server-b': ['summarize'] },
    };
    const result = await snapshot('my-profile');
    expect(Object.keys(result)).toContain('mcp__server-b__summarize');
    expect(Object.keys(result)).not.toContain('mcp__server-b__embed');
  });

  it('surfaces multiple servers when both are in profile', async () => {
    mockProfiles = {
      'full': { 'server-a': '*', 'server-b': '*' },
    };
    const result = await snapshot('full');
    expect(Object.keys(result)).toHaveLength(4);
  });

  it('falls back to default profile if named profile is missing', async () => {
    mockProfiles = { 'studio-chat-default': { 'server-a': '*' } };
    const result = await snapshot('nonexistent');
    expect(Object.keys(result)).toContain('mcp__server-a__search');
  });
});
