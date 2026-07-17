import { describe, expect, it } from 'vitest';
import {
  applyResolutions,
  type ResolutionAction,
} from '../../src/services/models/resolver/rewriteWorkflow.js';

function makeWorkflow(nodes: object[]) {
  return { nodes };
}

describe('applyResolutions', () => {
  it('returns a clone with no mutations when actions is empty', () => {
    const wf = makeWorkflow([{ id: 1, widgets_values: ['model.safetensors'] }]);
    const result = applyResolutions(wf, []) as typeof wf;
    expect(result).not.toBe(wf);
    expect((result.nodes[0] as { widgets_values: unknown[] }).widgets_values[0]).toBe('model.safetensors');
  });

  it('replaces the matching widget value with resolvedFilename when no save_path', () => {
    const wf = makeWorkflow([{
      id: 1,
      widgets_values: ['flux1-dev.safetensors', 'fp16'],
      properties: {},
    }]);
    const actions: ResolutionAction[] = [{
      nodeId: '1',
      widgetName: '0',
      originalValue: 'flux1-dev.safetensors',
      resolvedSavePath: '',
      resolvedFilename: 'flux1-dev.safetensors',
    }];
    const result = applyResolutions(wf, actions) as { nodes: Array<{ widgets_values: unknown[]; properties: Record<string, unknown> }> };
    expect(result.nodes[0].widgets_values[0]).toBe('flux1-dev.safetensors');
    expect(result.nodes[0].widgets_values[1]).toBe('fp16');
  });

  it('prefixes save_path when resolvedSavePath is non-empty', () => {
    const wf = makeWorkflow([{
      id: 5,
      widgets_values: ['ae.safetensors'],
      properties: {},
    }]);
    const actions: ResolutionAction[] = [{
      nodeId: '5',
      widgetName: 'ckpt_name',
      originalValue: 'ae.safetensors',
      resolvedSavePath: 'vae',
      resolvedFilename: 'ae.safetensors',
    }];
    const result = applyResolutions(wf, actions) as { nodes: Array<{ widgets_values: unknown[] }> };
    expect(result.nodes[0].widgets_values[0]).toBe('vae/ae.safetensors');
  });

  it('records provenance in studio_original_refs', () => {
    const wf = makeWorkflow([{
      id: 3,
      widgets_values: ['old-model.safetensors'],
      properties: {},
    }]);
    const actions: ResolutionAction[] = [{
      nodeId: '3',
      widgetName: 'ckpt_name',
      originalValue: 'old-model.safetensors',
      resolvedSavePath: 'checkpoints',
      resolvedFilename: 'new-model.safetensors',
    }];
    const result = applyResolutions(wf, actions) as {
      nodes: Array<{ properties: { studio_original_refs?: object[] } }>;
    };
    const refs = result.nodes[0].properties.studio_original_refs;
    expect(Array.isArray(refs)).toBe(true);
    expect(refs).toHaveLength(1);
    expect((refs as Array<{ originalValue: string }>)[0].originalValue).toBe('old-model.safetensors');
  });

  it('does not mutate the original workflow', () => {
    const wf = makeWorkflow([{ id: 1, widgets_values: ['model.safetensors'], properties: {} }]);
    const original = JSON.stringify(wf);
    applyResolutions(wf, [{
      nodeId: '1', widgetName: '0', originalValue: 'model.safetensors',
      resolvedSavePath: 'checkpoints', resolvedFilename: 'model.safetensors',
    }]);
    expect(JSON.stringify(wf)).toBe(original);
  });

  it('skips actions for non-existent nodes silently', () => {
    const wf = makeWorkflow([{ id: 1, widgets_values: ['model.safetensors'], properties: {} }]);
    const result = applyResolutions(wf, [{
      nodeId: '999', widgetName: '0', originalValue: 'model.safetensors',
      resolvedSavePath: '', resolvedFilename: 'model.safetensors',
    }]) as { nodes: Array<{ widgets_values: unknown[] }> };
    expect(result.nodes[0].widgets_values[0]).toBe('model.safetensors');
  });
});
