// Tests for the Wave J CivitAI URL -> staged workflow pipeline.
//
// Coverage:
//   - parseCivitaiTemplateUrl: three supported URL shapes + rejection
//     cases.
//   - stageFromCivitaiUrl: workflow discovered in files[], workflow
//     discovered in image.meta.workflow, NO_WORKFLOW_FOUND error, and
//     civitaiMeta propagation onto the staged row.
//
// Network is mocked by swapping `globalThis.fetch` so no HTTP traffic leaves
// the test process.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseCivitaiTemplateUrl,
  stageFromCivitaiUrl,
  ImportCivitaiError,
} from '../../../src/services/templates/importCivitaiTemplate.js';
import { abortStaging } from '../../../src/services/templates/importStaging.js';

function workflow(label: string): Record<string, unknown> {
  return {
    nodes: [
      { id: 1, type: 'UNETLoader', properties: { models: [{ name: `${label}.safetensors` }] } },
      { id: 2, type: 'SaveImage', widgets_values: [label] },
    ],
  };
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('parseCivitaiTemplateUrl', () => {
  it('parses /models/<id>', () => {
    const out = parseCivitaiTemplateUrl('https://civitai.com/models/12345');
    expect(out).toEqual({ modelId: 12345 });
  });

  it('parses /models/<id>?modelVersionId=<v>', () => {
    const out = parseCivitaiTemplateUrl(
      'https://civitai.com/models/12345/some-slug?modelVersionId=67890',
    );
    expect(out).toEqual({ modelId: 12345, versionId: 67890 });
  });

  it('parses /api/download/models/<v>', () => {
    const out = parseCivitaiTemplateUrl('https://civitai.com/api/download/models/555');
    expect(out).toEqual({ versionId: 555 });
  });

  it('rejects non-civitai hosts', () => {
    expect(parseCivitaiTemplateUrl('https://example.com/models/1')).toBeNull();
  });

  it('rejects malformed URLs', () => {
    expect(parseCivitaiTemplateUrl('not a url')).toBeNull();
  });

  it('rejects non-http schemes', () => {
    expect(parseCivitaiTemplateUrl('file:///etc/passwd')).toBeNull();
  });
});

describe('stageFromCivitaiUrl', () => {
  let originalFetch: typeof fetch;
  const stagedIds: string[] = [];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    // Clean up staged rows so the in-memory store doesn't leak between tests.
    for (const id of stagedIds.splice(0)) abortStaging(id);
  });

  it('stages a workflow found in files[] with type="Workflow"', async () => {
    const wf = workflow('file');
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (/\/models\/100$/.test(url)) {
        return jsonResponse({
          id: 100,
          name: 'My Civ Workflow',
          description: 'desc',
          tags: ['anime', { name: 'sd15' }],
          modelVersions: [
            {
              id: 200,
              files: [
                { name: 'wf.json', type: 'Workflow', downloadUrl: 'https://civitai.com/api/download/200' },
              ],
            },
          ],
        });
      }
      if (/\/api\/download\/200$/.test(url)) {
        return jsonResponse(wf);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const staged = await stageFromCivitaiUrl('https://civitai.com/models/100');
    stagedIds.push(staged.id);
    expect(staged.source).toBe('civitai');
    expect(staged.workflows).toHaveLength(1);
    expect(staged.workflows[0].entryName).toBe('wf.json');
    expect(staged.civitaiMeta).toEqual({
      modelId: 100,
      tags: ['anime', 'sd15'],
      description: 'desc',
      originalUrl: 'https://civitai.com/models/100',
    });
  });

  it('accepts a .json filename even when type is not Workflow', async () => {
    const wf = workflow('jsonfile');
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (/\/models\/101$/.test(url)) {
        return jsonResponse({
          id: 101,
          name: 'Json-name model',
          modelVersions: [
            {
              id: 201,
              files: [
                // No `type`, but .json suffix should still match.
                { name: 'workflow.json', downloadUrl: 'https://civitai.com/api/download/201' },
              ],
            },
          ],
        });
      }
      if (/\/api\/download\/201$/.test(url)) return jsonResponse(wf);
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const staged = await stageFromCivitaiUrl('https://civitai.com/models/101');
    stagedIds.push(staged.id);
    expect(staged.workflows).toHaveLength(1);
  });

  it('falls back to image.meta.workflow when files[] has no workflow', async () => {
    const wf = workflow('image-meta');
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (/\/models\/102$/.test(url)) {
        return jsonResponse({
          id: 102,
          name: 'Image meta fallback',
          modelVersions: [
            {
              id: 202,
              files: [
                // Non-workflow file (skipped).
                { name: 'model.safetensors', type: 'Model', downloadUrl: 'https://civitai.com/api/download/202' },
              ],
              images: [
                { url: 'https://cdn/cover.jpg', meta: { workflow: wf } },
              ],
            },
          ],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const staged = await stageFromCivitaiUrl('https://civitai.com/models/102');
    stagedIds.push(staged.id);
    expect(staged.workflows).toHaveLength(1);
    expect(staged.civitaiMeta?.modelId).toBe(102);
  });

  it('throws NO_WORKFLOW_FOUND when neither files nor image meta contain a workflow', async () => {
    globalThis.fetch = (async () => jsonResponse({
      id: 103,
      name: 'No workflow',
      modelVersions: [
        {
          id: 203,
          files: [{ name: 'weights.safetensors', type: 'Model', downloadUrl: 'https://civitai.com/download/203' }],
          images: [{ url: 'https://cdn/x.jpg' }],
        },
      ],
    })) as typeof fetch;

    await expect(stageFromCivitaiUrl('https://civitai.com/models/103'))
      .rejects.toBeInstanceOf(ImportCivitaiError);
    // Now make sure the code is NO_WORKFLOW_FOUND specifically.
    try {
      await stageFromCivitaiUrl('https://civitai.com/models/103');
    } catch (err) {
      expect(err).toBeInstanceOf(ImportCivitaiError);
      if (err instanceof ImportCivitaiError) {
        expect(err.code).toBe('NO_WORKFLOW_FOUND');
      }
    }
  });

  it('returns UNSUPPORTED_URL for malformed input', async () => {
    globalThis.fetch = (async () => {
      throw new Error('should not reach fetch');
    }) as typeof fetch;
    try {
      await stageFromCivitaiUrl('https://example.com/unknown');
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ImportCivitaiError);
      if (err instanceof ImportCivitaiError) {
        expect(err.code).toBe('UNSUPPORTED_URL');
      }
    }
  });
});
