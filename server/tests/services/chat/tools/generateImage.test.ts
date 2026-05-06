// Unit tests for the generate_image chat tool's readiness gate. Three
// scenarios: (1) defaultTemplate is empty -> no-template error string. (2)
// the configured default template doesn't exist in the in-memory cache ->
// "unknown template" not-ready string. (3) the template exists but its
// dependencies are missing -> the dynamic missing-items list, and no
// ComfyUI submission.
//
// The happy path (workflow fetch + comfyui submit) needs the full
// templates/comfyui stack and is exercised manually in dev — these tests
// cover only the gate behavior.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../../src/services/templates/index.js', () => ({
  getTemplate: vi.fn(),
  isUserWorkflow: vi.fn(),
  getUserWorkflowJson: vi.fn(),
}));

vi.mock('../../../../src/services/templates/dependencyCheck.js', () => ({
  checkTemplateDependencies: vi.fn(),
}));

vi.mock('../../../../src/services/comfyui.js', () => ({
  submitPrompt: vi.fn(),
}));

vi.mock('../../../../src/services/gallery.sentry.js', () => ({
  schedulePromptWatch: vi.fn(),
}));

vi.mock('../../../../src/services/workflow/index.js', () => ({
  getObjectInfo: vi.fn(),
  workflowToApiPrompt: vi.fn(),
}));

import { generateImageTool } from '../../../../src/services/chat/tools/generateImage.js';
import * as templates from '../../../../src/services/templates/index.js';
import * as depCheck from '../../../../src/services/templates/dependencyCheck.js';
import * as comfyui from '../../../../src/services/comfyui.js';
import { GENERATE_IMAGE_NO_TEMPLATE_ERROR } from '../../../../src/services/chat/prompts.js';

type ExecuteFn = (input: { prompt: string }, opts: unknown) => Promise<unknown>;

async function getExecute(): Promise<ExecuteFn> {
  const t = (await generateImageTool({ defaultTemplate: 'sdxl-base' })).tool as unknown as { execute: ExecuteFn };
  return t.execute;
}

function envelopeText(out: unknown): string {
  if (typeof out === 'string') return out;
  if (out && typeof out === 'object' && typeof (out as { text?: unknown }).text === 'string') {
    return (out as { text: string }).text;
  }
  throw new Error(`unexpected output shape: ${JSON.stringify(out)}`);
}

describe('generateImageTool readiness gate', () => {
  beforeEach(() => {
    vi.mocked(templates.getTemplate).mockReset();
    vi.mocked(depCheck.checkTemplateDependencies).mockReset();
    vi.mocked(comfyui.submitPrompt).mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it('returns the no-template error when defaultTemplate is empty', async () => {
    const t = (await generateImageTool({ defaultTemplate: '' })).tool as unknown as { execute: ExecuteFn };
    const out = await t.execute({ prompt: 'a cat' }, {});
    expect(envelopeText(out)).toBe(GENERATE_IMAGE_NO_TEMPLATE_ERROR);
    expect(comfyui.submitPrompt).not.toHaveBeenCalled();
  });

  it('returns an unknown-template message when the template is not cached', async () => {
    vi.mocked(templates.getTemplate).mockReturnValue(undefined);
    const out = await (await getExecute())({ prompt: 'a cat' }, {});
    expect(envelopeText(out)).toContain('default');
    expect(envelopeText(out)).toContain('not found');
    expect(depCheck.checkTemplateDependencies).not.toHaveBeenCalled();
    expect(comfyui.submitPrompt).not.toHaveBeenCalled();
  });

  it('lists missing items when the template has unmet dependencies', async () => {
    vi.mocked(templates.getTemplate).mockReturnValue({
      name: 'sdxl-base', title: 'SDXL Base', description: '',
      mediaType: 'image', tags: [],
      models: ['sd_xl_base_1.0.safetensors'],
      plugins: [{ repo: 'ltdrdata/comfyui-manager', title: 'Manager', installed: false }],
      category: 'image',
      io: { inputs: [], outputs: [] },
      thumbnail: [],
    });
    vi.mocked(depCheck.checkTemplateDependencies).mockResolvedValue({
      ready: false,
      required: [],
      missing: [
        { kind: 'model', name: 'qwen_3_4b.safetensors', url: '', directory: '', installed: false },
        { kind: 'model', name: 'ae.safetensors', url: '', directory: '', installed: false },
        { kind: 'plugin', classType: 'KSamplerAdvanced', subgraphName: null,
          repos: [{ repo: 'kijai/comfyui-wananimatepreprocess', title: 'WanAnimatePreproc' }],
          installed: false },
      ],
    });
    const out = await (await getExecute())({ prompt: 'a cat' }, {});
    const text = envelopeText(out);
    expect(text).toContain('qwen_3_4b.safetensors');
    expect(text).toContain('ae.safetensors');
    expect(text).toContain('kijai/comfyui-wananimatepreprocess');
    expect(text).toContain('Models or Plugins page');
    expect(depCheck.checkTemplateDependencies).toHaveBeenCalledOnce();
    expect(comfyui.submitPrompt).not.toHaveBeenCalled();
  });

  it('truncates the missing-items list at six entries with ", and more"', async () => {
    vi.mocked(templates.getTemplate).mockReturnValue({
      name: 'sdxl-base', title: 'SDXL Base', description: '',
      mediaType: 'image', tags: [], models: [],
      category: 'image', io: { inputs: [], outputs: [] }, thumbnail: [],
    });
    const missing = Array.from({ length: 8 }, (_, i) => ({
      kind: 'model' as const, name: `m${i}.safetensors`, url: '',
      directory: '', installed: false,
    }));
    vi.mocked(depCheck.checkTemplateDependencies).mockResolvedValue({
      ready: false, required: [], missing,
    });
    const out = await (await getExecute())({ prompt: 'a cat' }, {});
    const text = envelopeText(out);
    expect(text).toContain('m0.safetensors');
    expect(text).toContain('m5.safetensors');
    expect(text).not.toContain('m6.safetensors');
    expect(text).toContain('and more');
  });
});
