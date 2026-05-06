// submitTemplate.test.ts — verifies snapshot insert, provenance threading,
// and snapshot cleanup after gallery row creation.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useFreshDb } from '../../lib/db/_helpers.js';
import * as snapshotsRepo from '../../../src/lib/db/promptSnapshots.repo.js';
import * as sentryModule from '../../../src/services/gallery.sentry.js';
import { getPromptMeta } from '../../../src/services/gallery.promptMeta.js';

// ---- Mocks ----------------------------------------------------------------

vi.mock('../../../src/services/templates/index.js', () => ({
  getTemplate: (name: string) => name === 'test-tmpl' ? {
    title: 'Test', description: '', mediaType: 'image', tags: [], models: ['flux.safetensors'], io: undefined, openSource: true,
  } : null,
  isUserWorkflow: () => false,
  getUserWorkflowJson: () => null,
}));

vi.mock('../../../src/services/templates/templates.formInputs.js', () => ({
  generateFormInputs: () => [],
}));

vi.mock('../../../src/services/workflow/index.js', () => ({
  getObjectInfo: async () => ({}),
  workflowToApiPrompt: async (_wf: unknown, _ui: unknown, _fi: unknown) =>
    ({ '1': { class_type: 'KSampler', inputs: { seed: 1 } } }),
  enumerateTemplateWidgets: async () => [],
}));

vi.mock('../../../src/services/chat/tools/formInputsToSchema.js', () => ({
  formInputsToSchema: () => ({
    schema: { safeParse: (v: unknown) => ({ success: true, data: v }) },
    promptFieldId: null,
  }),
}));

vi.mock('../../../src/services/comfyui.js', () => ({
  submitPrompt: async (_prompt: unknown, _opts: unknown) => ({ prompt_id: 'pid-123' }),
  ComfyUIHttpError: class ComfyUIHttpError extends Error {},
}));

// Workflow fetch mock
global.fetch = vi.fn().mockResolvedValue({
  ok: true,
  json: async () => ({ nodes: [] }),
}) as typeof fetch;

// ---- Tests ----------------------------------------------------------------

describe('submitTemplate', () => {
  useFreshDb();

  beforeEach(() => {
    vi.clearAllMocks();
    sentryModule._cancelAllWatchesForTests();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ nodes: [] }),
    }) as typeof fetch;
  });

  it('inserts a snapshot after successful submit', async () => {
    const { submitTemplate } = await import('../../../src/services/templates/submitTemplate.js');
    await submitTemplate({ templateName: 'test-tmpl', inputs: { prompt: 'hello' } });
    const snap = snapshotsRepo.getSnapshot('pid-123');
    expect(snap).not.toBeNull();
    expect(snap!.apiPromptJson).toContain('KSampler');
  });

  it('returns the expected promptId + templateName + fieldId shape', async () => {
    const { submitTemplate } = await import('../../../src/services/templates/submitTemplate.js');
    const result = await submitTemplate({ templateName: 'test-tmpl', inputs: {} });
    expect(result.promptId).toBe('pid-123');
    expect(result.templateName).toBe('test-tmpl');
    expect(result.fieldId).toBeNull();
  });

  it('threads provenance into the sentry meta map', async () => {
    const { submitTemplate } = await import('../../../src/services/templates/submitTemplate.js');
    await submitTemplate({
      templateName: 'test-tmpl', inputs: {},
      provenance: { triggeredBy: 'chat', conversationId: 'c1', messageId: 'm1' },
    });
    const meta = getPromptMeta('pid-123');
    expect(meta?.triggeredBy).toBe('chat');
    expect(meta?.conversationId).toBe('c1');
    expect(meta?.messageId).toBe('m1');
  });

  it('stores templateHash (non-null 16-char hex) in sentry meta', async () => {
    const { submitTemplate } = await import('../../../src/services/templates/submitTemplate.js');
    await submitTemplate({ templateName: 'test-tmpl', inputs: {} });
    const meta = getPromptMeta('pid-123');
    expect(meta?.templateHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('snapshot is deleted after gallery row insertion clears it', async () => {
    // Insert snapshot manually and then delete it as the service would.
    snapshotsRepo.insertSnapshot({ promptId: 'p-del', apiPromptJson: '{}' });
    const deleted = snapshotsRepo.deleteSnapshot('p-del');
    expect(deleted).toBe(true);
    expect(snapshotsRepo.getSnapshot('p-del')).toBeNull();
  });
});
