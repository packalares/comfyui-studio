// workflow_from_image — Extract embedded ComfyUI workflow metadata from a PNG.
// Source: artokun tools/image-management.ts (workflow_from_image section).

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { logger } from '../../../../../lib/logger.js';
import { extractWorkflowFromPng } from './_lib/pngMetadata.js';

export interface WorkflowFromImageArgs {
  image_path: string;
}

export interface WorkflowFromImageResult {
  text: string;
  error?: string;
}

/**
 * Extract embedded ComfyUI workflow JSON from a PNG file.
 * ComfyUI stores the workflow in PNG tEXt chunks under the keys
 * "prompt" (API format) and "workflow" (UI format).
 */
export async function workflowFromImage(
  args: WorkflowFromImageArgs,
): Promise<WorkflowFromImageResult> {
  try {
    logger.info('MCP workflowFromImage', { path: args.image_path });

    const ext = extname(args.image_path).toLowerCase();
    if (ext !== '.png') {
      const msg = 'Workflow extraction only works with PNG files. ComfyUI embeds metadata in PNG tEXt chunks.';
      return { text: msg, error: msg };
    }

    const buffer = await readFile(args.image_path);
    const result = await extractWorkflowFromPng(buffer);

    const sections: string[] = [];
    if (result.prompt) {
      sections.push(
        '## API Format (prompt)\n\nThis is the executable workflow format:\n```json\n' +
          JSON.stringify(result.prompt, null, 2) +
          '\n```',
      );
    }
    if (result.workflow) {
      sections.push(
        '## UI Format (workflow)\n\nThis is the ComfyUI web UI format with layout data:\n```json\n' +
          JSON.stringify(result.workflow, null, 2) +
          '\n```',
      );
    }

    return {
      text: `# Workflow extracted from ${args.image_path}\n\n${sections.join('\n\n')}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('MCP workflowFromImage error', { error: msg });
    return { text: `Error: ${msg}`, error: msg };
  }
}
