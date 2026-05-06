// validate_workflow — Validate a ComfyUI workflow without executing it.
// Source: artokun tools/workflow-validate.ts.

import { logger } from '../../../../../lib/logger.js';
import { validateWorkflowSync } from './_lib/workflowValidator.js';
import { getObjectInfo } from './_lib/comfyClient.js';
import type { WorkflowJSON } from './_lib/mermaidConverter.js';

export interface ValidateWorkflowArgs {
  workflow: string | Record<string, unknown>;
}

export interface ValidateWorkflowResult {
  text: string;
  valid?: boolean;
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
 * Validate a ComfyUI workflow without executing it. Checks for missing node
 * types, broken connections, invalid output indices, missing models, and
 * output nodes. Returns a list of errors and warnings.
 */
export async function validateWorkflow(
  args: ValidateWorkflowArgs,
): Promise<ValidateWorkflowResult> {
  try {
    logger.info('MCP validateWorkflow');
    const workflow = parseWorkflow(args.workflow);

    let objectInfo: Awaited<ReturnType<typeof getObjectInfo>>;
    try {
      objectInfo = await getObjectInfo();
    } catch (err) {
      const msg = `Cannot connect to ComfyUI to validate: ${err instanceof Error ? err.message : err}`;
      return { text: `## Validation failed: cannot reach ComfyUI\n\n${msg}`, valid: false, error: msg };
    }

    const result = validateWorkflowSync(workflow, objectInfo);
    const lines: string[] = [];
    lines.push(`## ${result.summary}`, '');

    if (result.issues.length === 0) {
      lines.push('No issues found. The workflow is ready to execute.');
    } else {
      const errors = result.issues.filter(i => i.severity === 'error');
      const warnings = result.issues.filter(i => i.severity === 'warning');
      if (errors.length > 0) {
        lines.push('### Errors');
        for (const issue of errors) {
          const loc = issue.node_id ? `Node ${issue.node_id} (${issue.node_type})` : 'Workflow';
          lines.push(`- **${loc}**: ${issue.message}`);
        }
        lines.push('');
      }
      if (warnings.length > 0) {
        lines.push('### Warnings');
        for (const issue of warnings) {
          const loc = issue.node_id ? `Node ${issue.node_id} (${issue.node_type})` : 'Workflow';
          lines.push(`- **${loc}**: ${issue.message}`);
        }
      }
    }

    return { text: lines.join('\n'), valid: result.valid };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('MCP validateWorkflow error', { error: msg });
    return { text: `Error: ${msg}`, valid: false, error: msg };
  }
}
