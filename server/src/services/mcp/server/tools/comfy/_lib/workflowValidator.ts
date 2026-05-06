// Workflow validator — checks for missing node types, broken connections,
// invalid output indices, model references, and output nodes.
// Ported from artokun's services/workflow-validator.ts.

import type { WorkflowNode, WorkflowJSON } from './mermaidConverter.js';
import type { ObjectInfo } from './comfyClient.js';

export interface ValidationIssue {
  severity: 'error' | 'warning';
  node_id: string;
  node_type: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  summary: string;
}

export type { WorkflowJSON, WorkflowNode };

function checkModelRefs(
  nodeId: string,
  classType: string,
  inputs: Record<string, unknown>,
  issues: ValidationIssue[],
  objectInfo: ObjectInfo,
): void {
  const nodeDef = objectInfo[classType];
  if (!nodeDef) return;
  const allDefs: Record<string, unknown> = {
    ...(nodeDef.input?.required ?? {}),
    ...(nodeDef.input?.optional ?? {}),
  };
  for (const [inputName, inputSpec] of Object.entries(allDefs)) {
    const value = inputs[inputName];
    if (typeof value !== 'string') continue;
    if (!Array.isArray(inputSpec) || !Array.isArray((inputSpec as unknown[])[0])) continue;
    const validValues = (inputSpec as unknown[])[0] as string[];
    if (!/\.(safetensors|gguf|ckpt|pt|pth|bin|sft)$/i.test(value)) continue;
    if (!validValues.includes(value)) {
      issues.push({
        severity: 'warning',
        node_id: nodeId,
        node_type: classType,
        message: `Model "${value}" not found in ${classType}'s "${inputName}" options (${validValues.length} available).`,
      });
    }
  }
}

export function validateWorkflowSync(
  workflow: WorkflowJSON,
  objectInfo: ObjectInfo,
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const nodeIds = Object.keys(workflow);

  for (const nodeId of nodeIds) {
    const node = workflow[nodeId];
    const classType = node.class_type;
    const nodeDef = objectInfo[classType];
    if (!nodeDef) {
      issues.push({ severity: 'error', node_id: nodeId, node_type: classType,
        message: `Unknown node type "${classType}". This node may not be installed.` });
      continue;
    }
    const required = nodeDef.input?.required ?? {};
    for (const inputName of Object.keys(required)) {
      if (!(inputName in node.inputs)) {
        issues.push({ severity: 'error', node_id: nodeId, node_type: classType,
          message: `Missing required input "${inputName}"` });
      }
    }
    for (const [inputName, value] of Object.entries(node.inputs)) {
      if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string' || typeof value[1] !== 'number') continue;
      const [sourceId, outputIndex] = value as [string, number];
      if (!workflow[sourceId]) {
        issues.push({ severity: 'error', node_id: nodeId, node_type: classType,
          message: `Input "${inputName}" references node "${sourceId}" which doesn't exist.` });
        continue;
      }
      const srcDef = objectInfo[workflow[sourceId].class_type];
      if (srcDef?.output && outputIndex >= srcDef.output.length) {
        issues.push({ severity: 'error', node_id: nodeId, node_type: classType,
          message: `Input "${inputName}" references output index ${outputIndex} of "${sourceId}" but it only has ${srcDef.output.length} outputs.` });
      }
    }
    for (const [inputName, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value) && value.length === 2 && value[0] === nodeId) {
        issues.push({ severity: 'error', node_id: nodeId, node_type: classType,
          message: `Self-referencing connection on input "${inputName}"` });
      }
    }
    checkModelRefs(nodeId, classType, node.inputs, issues, objectInfo);
  }

  const hasOutput = nodeIds.some(id => {
    const ct = workflow[id].class_type;
    return ct === 'SaveImage' || ct === 'PreviewImage' || ct === 'SaveAnimatedWEBP' ||
      ct === 'SaveAnimatedPNG' || objectInfo[ct]?.output_node === true;
  });
  if (!hasOutput) {
    issues.push({ severity: 'warning', node_id: '', node_type: '',
      message: 'Workflow has no output node (SaveImage, PreviewImage, etc.).' });
  }

  const errors = issues.filter(i => i.severity === 'error');
  const warnings = issues.filter(i => i.severity === 'warning');
  const valid = errors.length === 0;
  const summary = valid
    ? warnings.length > 0 ? `Workflow is valid with ${warnings.length} warning(s)` : 'Workflow is valid'
    : `Workflow has ${errors.length} error(s) and ${warnings.length} warning(s)`;

  return { valid, issues, summary };
}
