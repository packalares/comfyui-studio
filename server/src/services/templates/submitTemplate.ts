// Extracted submit logic shared by the `generate_image` chat tool, MCP
// `submitGeneration` tool, and the HTTP `/api/generate` route (Fix 3).

import { createHash } from 'crypto';
import * as templates from './index.js';
import { generateFormInputs } from './templates.formInputs.js';
import { fetchTemplateWorkflow } from './dependencyCheck.js';
import { schedulePromptWatch } from '../gallery.sentry.js';
import { type PromptMeta } from '../gallery.promptMeta.js';
import { insertSnapshot } from '../../lib/db/promptSnapshots.repo.js';
import { env } from '../../config/env.js';
import type { RawTemplate } from './types.js';
import {
  getObjectInfo,
  workflowToApiPrompt,
  enumerateTemplateWidgets,
} from '../workflow/index.js';
import type { EnumeratedWidget } from '../../contracts/workflow.contract.js';
import { applyNodeOverrides, applyProxyOverrides, splitAdvancedSettings } from './advancedSettings.js';
import * as comfyui from '../comfyui.js';
import { formInputsToSchema } from '../chat/tools/formInputsToSchema.js';
import { getDb } from '../../lib/db/connection.js';

export interface SubmitProvenance {
  triggeredBy: 'ui' | 'chat' | 'mcp';
  conversationId?: string;
  messageId?: string;
}

export interface SubmitTemplateInput {
  templateName: string;
  inputs: { prompt?: string; [k: string]: unknown };
  advancedSettings?: unknown;
  provenance?: SubmitProvenance;
}

export interface SubmitTemplateResult {
  promptId: string;
  templateName: string;
  fieldId: string | null;
}

async function buildOverridesFromArgs(
  workflow: Record<string, unknown>,
  templateName: string,
  args: Record<string, unknown>,
): Promise<Record<string, Record<string, unknown>>> {
  const overrides: Record<string, Record<string, unknown>> = {};
  const widgets = await enumerateTemplateWidgets(workflow, templateName);
  const byName = new Map<string, EnumeratedWidget>();
  for (const w of widgets) {
    if (!byName.has(w.widgetName)) byName.set(w.widgetName, w);
  }
  for (const [argName, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    if (argName === 'prompt') continue;
    const w = byName.get(argName);
    if (!w) continue;
    if (!overrides[w.nodeId]) overrides[w.nodeId] = {};
    overrides[w.nodeId][w.widgetName] = value;
  }
  return overrides;
}

/** Compute a lightweight fingerprint for model files. `size-mtime` per file.
 *  Exported so the inline `/api/generate` pipeline can attach the same
 *  fingerprint to UI-triggered gallery rows without round-tripping through
 *  submitTemplate's stricter input contract. */
export function computeModelFingerprint(modelNames: string[]): string | null {
  if (!modelNames || modelNames.length === 0) return null;
  try {
    const db = getDb();
    const out: Record<string, string> = {};
    for (const name of modelNames) {
      const row = db.prepare('SELECT size, scanned_at FROM model_files WHERE filename = ? LIMIT 1')
        .get(name) as { size: number; scanned_at: number } | undefined;
      if (row) out[name] = `${row.size}-${row.scanned_at}`;
    }
    return Object.keys(out).length > 0 ? JSON.stringify(out) : null;
  } catch { return null; }
}

export async function submitTemplate(
  input: SubmitTemplateInput,
): Promise<SubmitTemplateResult> {
  const template = templates.getTemplate(input.templateName);
  if (!template) {
    throw new Error(`unknown template "${input.templateName}"`);
  }

  let workflow: Record<string, unknown>;
  if (templates.isUserWorkflow(input.templateName)) {
    const local = templates.getUserWorkflowJson(input.templateName);
    if (!local) throw new Error('user workflow file missing');
    workflow = local;
  } else {
    const wfRes = await fetch(
      `${env.COMFYUI_URL}/templates/${encodeURIComponent(input.templateName)}.json`,
    );
    if (!wfRes.ok) throw new Error(`workflow fetch ${wfRes.status}`);
    workflow = await wfRes.json() as Record<string, unknown>;
  }

  // Fix 4: template hash computed BEFORE any overrides.
  const templateHash = createHash('sha1').update(JSON.stringify(workflow)).digest('hex').slice(0, 16);

  // Apply advanced-settings proxy overrides (before conversion).
  if (input.advancedSettings) {
    const { proxyEntries } = splitAdvancedSettings(input.advancedSettings);
    applyProxyOverrides(workflow, proxyEntries);
  }

  const rawForBindings: RawTemplate = {
    name: input.templateName,
    title: template.title,
    description: template.description,
    mediaType: template.mediaType,
    tags: template.tags,
    models: template.models,
    io: template.io,
  };

  const objectInfo = await getObjectInfo();
  const formInputs = generateFormInputs(rawForBindings, workflow, objectInfo);
  const { schema, promptFieldId } = formInputsToSchema(formInputs);

  const parsed = schema.safeParse(input.inputs);
  if (!parsed.success) {
    throw new Error(`arg validation: ${parsed.error.message}`);
  }

  const userInputs: Record<string, unknown> = {};
  if (promptFieldId && typeof input.inputs.prompt === 'string') {
    userInputs[promptFieldId] = input.inputs.prompt;
  }
  for (const field of formInputs) {
    if (promptFieldId && field.id === promptFieldId) continue;
    const v = (parsed.data as Record<string, unknown>)[field.id];
    if (v !== undefined) userInputs[field.id] = v;
  }

  const nodeOverrides = await buildOverridesFromArgs(workflow, input.templateName, input.inputs);
  if (input.advancedSettings) {
    const { nodeOverrides: advNodeOverrides } = splitAdvancedSettings(input.advancedSettings);
    for (const [nid, vals] of Object.entries(advNodeOverrides)) {
      if (!nodeOverrides[nid]) nodeOverrides[nid] = {};
      Object.assign(nodeOverrides[nid], vals);
    }
  }
  const apiPrompt = await workflowToApiPrompt(workflow, userInputs, formInputs);
  applyNodeOverrides(apiPrompt, nodeOverrides);

  const attachApiKey = template.openSource === false;
  const result = await comfyui.submitPrompt(apiPrompt, { attachApiKey });
  if (!result?.prompt_id) {
    throw new Error('comfyui did not return a prompt_id');
  }

  // Fix 4: model fingerprint from model_files table.
  const modelFingerprint = computeModelFingerprint(template.models?.map(m =>
    typeof m === 'string' ? m : (m as { filename?: string }).filename ?? '',
  ).filter(Boolean) ?? []);

  // Fix 1: store snapshot so gallery hydration can recover if history is slow.
  try {
    insertSnapshot({
      promptId: result.prompt_id,
      apiPromptJson: JSON.stringify(apiPrompt),
      templateName: input.templateName,
    });
  } catch { /* snapshot failure must not fail the submit */ }

  // Fix 2: thread provenance + fingerprints through the sentry map.
  const meta: PromptMeta = {
    triggeredBy: input.provenance?.triggeredBy ?? null,
    conversationId: input.provenance?.conversationId ?? null,
    messageId: input.provenance?.messageId ?? null,
    modelFingerprint,
    templateHash,
  };
  schedulePromptWatch(result.prompt_id, meta);
  return {
    promptId: result.prompt_id,
    templateName: input.templateName,
    fieldId: promptFieldId,
  };
}

/** Convenience re-export so `generateImage.ts` can import the workflow fetch
 *  without touching `dependencyCheck.ts` directly from MCP code. */
export { fetchTemplateWorkflow };
