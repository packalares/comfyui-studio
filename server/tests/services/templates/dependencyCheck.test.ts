// Unit tests for `checkTemplateDependencies` — the workflow-walking
// dependency check shared by the `POST /api/check-dependencies` route and
// the chat `generate_image` tool's readiness gate. The full pipeline pulls
// from many sources (catalog, model_files index, plugin canonicalizer,
// /object_info), so we exercise the orchestrator with the model + plugin
// helpers stubbed in. Round-trip testing of those helpers lives in
// dependencyCheck.models / dependencyCheck.plugins call-site coverage.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../src/services/templates/userTemplates.js', () => ({
  isUserWorkflow: vi.fn().mockReturnValue(true),
  getUserWorkflowJson: vi.fn().mockReturnValue({
    nodes: [
      { id: 1, type: 'CheckpointLoaderSimple', widgets_values: ['z_image_turbo_bf16.safetensors'] },
    ],
  }),
}));

vi.mock('../../../src/services/catalog.js', () => ({
  seedFromComfyUI: vi.fn(),
  getModel: vi.fn(),
  upsertModel: vi.fn(),
  isSizeStale: vi.fn().mockReturnValue(false),
  refreshMany: vi.fn(),
}));

vi.mock('../../../src/services/templates/dependencyCheck.models.js', () => ({
  collectRequirements: vi.fn(),
  refreshStaleEntries: vi.fn(),
  fetchInstalledModels: vi.fn().mockResolvedValue([]),
  installedNameSet: vi.fn().mockReturnValue(new Set()),
  collectModelFolders: vi.fn().mockResolvedValue({}),
  buildRequiredList: vi.fn(),
}));

vi.mock('../../../src/services/templates/dependencyCheck.plugins.js', () => ({
  buildPluginRequirementList: vi.fn(),
}));

vi.mock('../../../src/services/workflow/collect.js', () => ({
  collectAllWorkflowNodes: vi.fn().mockReturnValue([
    { id: 1, type: 'CheckpointLoaderSimple', widgets_values: ['x'] },
  ]),
}));

import {
  checkTemplateDependencies, resetDependencyCheckCacheForTests,
} from '../../../src/services/templates/dependencyCheck.js';
import * as modelHelpers from '../../../src/services/templates/dependencyCheck.models.js';
import * as pluginHelpers from '../../../src/services/templates/dependencyCheck.plugins.js';

describe('checkTemplateDependencies', () => {
  beforeEach(() => {
    resetDependencyCheckCacheForTests();
    vi.mocked(modelHelpers.collectRequirements).mockReset();
    vi.mocked(modelHelpers.buildRequiredList).mockReset();
    vi.mocked(pluginHelpers.buildPluginRequirementList).mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it('returns ready when every model + plugin is installed', async () => {
    vi.mocked(modelHelpers.collectRequirements).mockReturnValue({
      required: new Set(['z_image_turbo_bf16.safetensors']),
      templateDir: new Map(),
      repoEntries: new Map(),
    });
    vi.mocked(modelHelpers.buildRequiredList).mockReturnValue({
      required: [{
        name: 'z_image_turbo_bf16.safetensors',
        url: '', directory: '', installed: true,
      }],
      missing: [],
    });
    vi.mocked(pluginHelpers.buildPluginRequirementList).mockResolvedValue({
      required: [], missing: [],
    });
    const result = await checkTemplateDependencies('image_z_image_turbo');
    expect(result.ready).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.required).toHaveLength(1);
    expect(result.required[0].kind).toBe('model');
  });

  it('surfaces missing model filenames in the result', async () => {
    vi.mocked(modelHelpers.collectRequirements).mockReturnValue({
      required: new Set(['ae.safetensors', 'qwen_3_4b.safetensors']),
      templateDir: new Map(),
      repoEntries: new Map(),
    });
    vi.mocked(modelHelpers.buildRequiredList).mockReturnValue({
      required: [
        { name: 'ae.safetensors', url: '', directory: '', installed: false },
        { name: 'qwen_3_4b.safetensors', url: '', directory: '', installed: false },
      ],
      missing: [
        { name: 'ae.safetensors', url: '', directory: '', installed: false },
        { name: 'qwen_3_4b.safetensors', url: '', directory: '', installed: false },
      ],
    });
    vi.mocked(pluginHelpers.buildPluginRequirementList).mockResolvedValue({
      required: [], missing: [],
    });
    const result = await checkTemplateDependencies('image_z_image_turbo');
    expect(result.ready).toBe(false);
    expect(result.missing).toHaveLength(2);
    const names = result.missing
      .filter((m) => m.kind === 'model')
      .map((m) => m.name);
    expect(names).toContain('ae.safetensors');
    expect(names).toContain('qwen_3_4b.safetensors');
  });

  it('surfaces missing plugin class types in the result', async () => {
    vi.mocked(modelHelpers.collectRequirements).mockReturnValue({
      required: new Set(),
      templateDir: new Map(),
      repoEntries: new Map(),
    });
    vi.mocked(modelHelpers.buildRequiredList).mockReturnValue({
      required: [], missing: [],
    });
    vi.mocked(pluginHelpers.buildPluginRequirementList).mockResolvedValue({
      required: [{
        kind: 'plugin', classType: 'KSamplerAdvanced', subgraphName: null,
        repos: [{ repo: 'kijai/example-plugin', title: 'Example' }],
        installed: false,
      }],
      missing: [{
        kind: 'plugin', classType: 'KSamplerAdvanced', subgraphName: null,
        repos: [{ repo: 'kijai/example-plugin', title: 'Example' }],
        installed: false,
      }],
    });
    const result = await checkTemplateDependencies('some-template');
    expect(result.ready).toBe(false);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0].kind).toBe('plugin');
    if (result.missing[0].kind === 'plugin') {
      expect(result.missing[0].classType).toBe('KSamplerAdvanced');
      expect(result.missing[0].repos[0].repo).toBe('kijai/example-plugin');
    }
  });

  it('memoizes within the 5-second TTL', async () => {
    vi.mocked(modelHelpers.collectRequirements).mockReturnValue({
      required: new Set(), templateDir: new Map(), repoEntries: new Map(),
    });
    vi.mocked(modelHelpers.buildRequiredList).mockReturnValue({
      required: [], missing: [],
    });
    vi.mocked(pluginHelpers.buildPluginRequirementList).mockResolvedValue({
      required: [], missing: [],
    });
    await checkTemplateDependencies('foo');
    await checkTemplateDependencies('foo');
    expect(vi.mocked(modelHelpers.collectRequirements)).toHaveBeenCalledOnce();
  });
});
