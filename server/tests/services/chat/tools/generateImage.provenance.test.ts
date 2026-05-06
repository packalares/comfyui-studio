// Tests that conversationId + messageId in GenerateImageConfig thread through
// to the provenance argument passed to submitTemplate.

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../../../src/services/templates/index.js', () => ({
  getTemplate: vi.fn(),
  isUserWorkflow: vi.fn(),
  getUserWorkflowJson: vi.fn(),
}));

vi.mock('../../../../src/services/templates/dependencyCheck.js', () => ({
  checkTemplateDependencies: vi.fn(),
}));

// Mock submitTemplate directly so we can assert the provenance arg.
vi.mock('../../../../src/services/templates/submitTemplate.js', () => ({
  submitTemplate: vi.fn(),
  fetchTemplateWorkflow: vi.fn(),
}));

vi.mock('../../../../src/services/workflow/index.js', () => ({
  getObjectInfo: vi.fn(),
  workflowToApiPrompt: vi.fn(),
  enumerateTemplateWidgets: vi.fn(),
}));

import { generateImageTool } from '../../../../src/services/chat/tools/generateImage.js';
import * as templates from '../../../../src/services/templates/index.js';
import * as depCheck from '../../../../src/services/templates/dependencyCheck.js';
import * as submitMod from '../../../../src/services/templates/submitTemplate.js';

type ExecuteFn = (input: { prompt: string }, opts: unknown) => Promise<unknown>;

const TEMPLATE_STUB = {
  name: 'sdxl-base', title: 'SDXL Base', description: '',
  mediaType: 'image' as const, tags: [], models: [],
  category: 'image', io: { inputs: [], outputs: [] }, thumbnail: [],
};

describe('generateImageTool provenance threading', () => {
  beforeEach(() => {
    vi.mocked(templates.getTemplate).mockReset();
    vi.mocked(depCheck.checkTemplateDependencies).mockReset();
    vi.mocked(submitMod.submitTemplate).mockReset();
    vi.mocked(templates.getTemplate).mockReturnValue(TEMPLATE_STUB);
    vi.mocked(depCheck.checkTemplateDependencies).mockResolvedValue({
      ready: true, required: [], missing: [],
    });
    vi.mocked(submitMod.submitTemplate).mockResolvedValue({
      promptId: 'prompt-1',
      templateName: 'sdxl-base',
      fieldId: 'text',
    });
  });

  it('passes conversationId and messageId to submitTemplate provenance', async () => {
    const tool = await generateImageTool({
      defaultTemplate: 'sdxl-base',
      conversationId: 'c1',
      messageId: 'm1',
    });
    const execute = (tool.tool as unknown as { execute: ExecuteFn }).execute;
    await execute({ prompt: 'a landscape' }, {});

    expect(submitMod.submitTemplate).toHaveBeenCalledOnce();
    const call = vi.mocked(submitMod.submitTemplate).mock.calls[0][0];
    expect(call.provenance).toEqual({
      triggeredBy: 'chat',
      conversationId: 'c1',
      messageId: 'm1',
    });
  });

  it('passes undefined chat IDs when config omits them', async () => {
    const tool = await generateImageTool({ defaultTemplate: 'sdxl-base' });
    const execute = (tool.tool as unknown as { execute: ExecuteFn }).execute;
    await execute({ prompt: 'a cat' }, {});

    expect(submitMod.submitTemplate).toHaveBeenCalledOnce();
    const call = vi.mocked(submitMod.submitTemplate).mock.calls[0][0];
    expect(call.provenance?.triggeredBy).toBe('chat');
    expect(call.provenance?.conversationId).toBeUndefined();
    expect(call.provenance?.messageId).toBeUndefined();
  });
});
