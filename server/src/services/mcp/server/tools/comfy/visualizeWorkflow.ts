// visualize_workflow — Convert a ComfyUI workflow JSON into a Mermaid diagram.
// Source: artokun tools/workflow-visualize.ts (visualize_workflow section).

import { logger } from '../../../../../lib/logger.js';
import { convertToMermaid } from './_lib/mermaidConverter.js';
import type { WorkflowJSON } from './_lib/mermaidConverter.js';

export interface VisualizeWorkflowArgs {
  workflow: string | Record<string, unknown>;
  show_values?: boolean;
  direction?: 'LR' | 'TB';
}

export interface VisualizeWorkflowResult {
  text: string;
  error?: string;
}

function parseWorkflow(input: unknown): WorkflowJSON {
  if (typeof input === 'string') {
    let parsed: unknown;
    try { parsed = JSON.parse(input); } catch (e) {
      throw new Error(`Invalid JSON string: ${e instanceof Error ? e.message : e}`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Workflow JSON must be an object with node IDs as keys');
    }
    return parsed as WorkflowJSON;
  }
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    return input as WorkflowJSON;
  }
  throw new Error('Workflow must be a JSON string or object');
}

/**
 * Convert a ComfyUI workflow JSON into a Mermaid flowchart diagram.
 * Returns mermaid syntax showing nodes grouped by category with connections
 * labeled by data type.
 */
export async function visualizeWorkflow(
  args: VisualizeWorkflowArgs,
): Promise<VisualizeWorkflowResult> {
  try {
    logger.info('MCP visualizeWorkflow');

    const workflow = parseWorkflow(args.workflow);
    const nodeCount = Object.keys(workflow).length;
    if (nodeCount === 0) {
      return { text: 'Error: Workflow contains no nodes', error: 'Workflow contains no nodes' };
    }

    const mermaid = convertToMermaid(workflow, {
      showValues: args.show_values ?? true,
      direction: args.direction ?? 'LR',
    });

    return { text: `\`\`\`mermaid\n${mermaid}\n\`\`\`` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('MCP visualizeWorkflow error', { error: msg });
    return { text: `Error: ${msg}`, error: msg };
  }
}
