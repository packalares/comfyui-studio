// analyze_workflow — Structured analysis of a ComfyUI workflow JSON.
// Source: artokun tools/workflow-library.ts (analyze_workflow section).
// Deviation: artokun loads workflows from ComfyUI's userdata storage by filename.
// Studio's MCP phase-1 accepts the workflow JSON directly (file loading is
// out of scope for this port). view='summary' returns a text summary;
// view='flat' returns a mermaid diagram.

import { logger } from '../../../../../lib/logger.js';
import { convertToMermaid } from './_lib/mermaidConverter.js';
import type { WorkflowJSON } from './_lib/mermaidConverter.js';

export type AnalyzeView = 'summary' | 'flat';

export interface AnalyzeWorkflowArgs {
  workflow: string | Record<string, unknown>;
  view?: AnalyzeView;
}

export interface AnalyzeWorkflowResult {
  text: string;
  error?: string;
}

function parseWorkflow(input: unknown): WorkflowJSON {
  if (typeof input === 'string') {
    let parsed: unknown;
    try { parsed = JSON.parse(input); } catch (e) {
      throw new Error(`Invalid JSON: ${e instanceof Error ? e.message : e}`);
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

function buildSummary(workflow: WorkflowJSON): string {
  const entries = Object.entries(workflow);
  if (entries.length === 0) return 'Workflow is empty.';

  const lines: string[] = [`# Workflow Analysis`, '', `**${entries.length} nodes**`, ''];

  // Gather node type counts
  const typeCounts = new Map<string, number>();
  for (const [, node] of entries) {
    typeCounts.set(node.class_type, (typeCounts.get(node.class_type) ?? 0) + 1);
  }
  lines.push('## Node Types');
  for (const [type, count] of [...typeCounts.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${type}${count > 1 ? ` x${count}` : ''}`);
  }
  lines.push('');

  // Connections summary
  let connCount = 0;
  for (const [, node] of entries) {
    for (const v of Object.values(node.inputs)) {
      if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'number') {
        connCount++;
      }
    }
  }
  lines.push(`## Connections`, `${connCount} total connections`, '');

  // Key widget values from sampler / loader nodes
  const keyNodes = entries.filter(([, n]) =>
    n.class_type.startsWith('KSampler') || n.class_type.startsWith('CheckpointLoader'),
  );
  if (keyNodes.length > 0) {
    lines.push('## Key Settings');
    for (const [id, node] of keyNodes) {
      lines.push(`**${node._meta?.title ?? node.class_type}** (node ${id})`);
      for (const [k, v] of Object.entries(node.inputs)) {
        if (Array.isArray(v)) continue;
        lines.push(`  - ${k}: ${v}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Analyze a ComfyUI workflow JSON. Returns a structured text summary (view='summary')
 * or a mermaid diagram (view='flat').
 *
 * Note: artokun's original also supported loading workflows by filename from
 * ComfyUI's userdata storage. That path is not ported here; pass the workflow
 * JSON directly.
 */
export async function analyzeWorkflow(
  args: AnalyzeWorkflowArgs,
): Promise<AnalyzeWorkflowResult> {
  try {
    logger.info('MCP analyzeWorkflow', { view: args.view ?? 'summary' });
    const workflow = parseWorkflow(args.workflow);
    const nodeCount = Object.keys(workflow).length;
    if (nodeCount === 0) {
      return { text: 'Error: Workflow contains no nodes', error: 'Workflow contains no nodes' };
    }

    const view = args.view ?? 'summary';
    if (view === 'flat') {
      const mermaid = convertToMermaid(workflow, { showValues: true, direction: 'LR' });
      return { text: `\`\`\`mermaid\n${mermaid}\n\`\`\`` };
    }

    return { text: buildSummary(workflow) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('MCP analyzeWorkflow error', { error: msg });
    return { text: `Error: ${msg}`, error: msg };
  }
}
