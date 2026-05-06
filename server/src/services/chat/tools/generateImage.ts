// `generate_image` chat tool — submits Studio's existing template-based
// generate flow (`POST /api/generate` shares the same code path) and returns
// the resulting `prompt_id`. Image delivery is deferred: ComfyUI runs the
// workflow asynchronously; the gallery sentry persists the row when it
// finishes; the existing UI gallery / WS channel surfaces the asset.
//
// v1 limitation: this tool returns immediately with the prompt id; it does
// NOT block waiting for the image URL. Per the phase-2 task, the chat UI
// can subscribe to gallery events to inject the finished asset later.

import { z } from 'zod';
import { defineTool } from './defineTool.js';
import * as templates from '../../templates/index.js';
import { checkTemplateDependencies } from '../../templates/dependencyCheck.js';
import type { RequiredItem } from '../../../contracts/generation.contract.js';
import { enumerateTemplateWidgets } from '../../workflow/index.js';
import { fetchTemplateWorkflow } from '../../templates/dependencyCheck.js';
import { logger } from '../../../lib/logger.js';
import { submitTemplate } from '../../templates/submitTemplate.js';
import {
  TOOL_DESCRIPTION_GENERATE_IMAGE,
  GENERATE_IMAGE_QUEUED_RESULT,
  GENERATE_IMAGE_PROMPT_FIELD_NOTE,
  GENERATE_IMAGE_NO_FIELD_NOTE,
  GENERATE_IMAGE_FAILED_PREFIX,
  GENERATE_IMAGE_NO_TEMPLATE_ERROR,
} from '../prompts.js';

export interface GenerateImageConfig {
  /** Template name to use when the LLM omits one. Empty = no default. */
  defaultTemplate: string;
  /** Optional conversation context so gallery rows carry the chat IDs. */
  conversationId?: string;
  messageId?: string;
}

/** Structured envelope so the chat UI can subscribe to a `gallery` WS event
 *  filtered by `promptId` and swap in the rendered image when ComfyUI emits
 *  the corresponding `execution_success`. The model still consumes the
 *  human-readable `text` (toolDispatch.toContentString unwraps it). */
export interface GenerateImageEnvelope {
  text: string;
  promptId: string;
  templateName: string;
}
export type GenerateImageOutput = string | GenerateImageEnvelope;

// Registration schema declares only `prompt` — width / height / steps / cfg /
// seed / sampler / negative_prompt and any template-specific knobs flow
// through `.passthrough()`. The LLM learns about them from the per-template
// JSON snippet appended to the tool description (built by
// `buildPerTemplateDescription` below) — strict schema fields would lock us
// into one fixed list, but ComfyUI workflows expose different knobs per
// template (img2img has `denoise`, audio templates have `length_seconds`,
// etc.). The widget enumeration is the single source of truth — both for
// what the model sees AND for which node receives the override value
// (see `buildNodeOverridesFromArgs`).
const inputSchema = z.object({
  prompt: z.string().min(1).describe(
    'Text prompt for the image. Routed to the template\'s primary prompt field.',
  ),
}).passthrough();

// Per-template tool description cache. Keyed by templateName; rebuilt every 5
// minutes (long enough to cut HTTP-fetch cost on rapid chat:start cadence,
// short enough that newly-imported workflows surface their widgets without
// a server restart).
const DESCRIPTION_TTL_MS = 5 * 60 * 1000;
const descriptionCache = new Map<string, { value: string; expiresAt: number }>();

/**
 * Build the per-template tool description: base prompt-trigger string plus a
 * compact JSON summary of every overridable widget on the active template.
 * The model reads this and learns which knobs exist (width / height / steps
 * for image templates, length_seconds / fps for video, denoise for img2img,
 * etc.) without us needing to maintain a hardcoded mapping table. Returns
 * the base description on any failure (network / unknown template) so the
 * tool stays usable even when widget enumeration is unavailable.
 */
async function buildPerTemplateDescription(templateName: string): Promise<string> {
  const now = Date.now();
  const cached = descriptionCache.get(templateName);
  if (cached && cached.expiresAt > now) return cached.value;

  let value = TOOL_DESCRIPTION_GENERATE_IMAGE;
  try {
    const workflow = await fetchTemplateWorkflow(templateName);
    if (workflow) {
      const widgets = await enumerateTemplateWidgets(workflow, templateName);
      const json: Record<string, Record<string, unknown>> = {};
      for (const w of widgets) {
        // `formClaimed` widgets are routed through the form-input path
        // (prompt, image upload). Re-exposing them as overrides confuses the
        // model into double-setting the prompt.
        if (w.formClaimed) continue;
        const entry: Record<string, unknown> = { default: w.value };
        if (w.min !== undefined) entry.min = w.min;
        if (w.max !== undefined) entry.max = w.max;
        if (w.step !== undefined) entry.step = w.step;
        if (w.options && w.options.length > 0) {
          entry.options = w.options.map(o => o.value);
        }
        json[w.widgetName] = entry;
      }
      if (Object.keys(json).length > 0) {
        value = TOOL_DESCRIPTION_GENERATE_IMAGE
          + '\n\nOverridable fields for the active template (set any of these '
          + 'as args when the user requests them; omit to use the default):\n'
          + JSON.stringify(json);
      }
    }
  } catch {
    // Fall through with the base description — better the model can call the
    // tool than refuse because of a transient enumeration failure.
  }
  descriptionCache.set(templateName, { value, expiresAt: now + DESCRIPTION_TTL_MS });
  return value;
}

/**
 * Compose the not-ready string the LLM sees as the tool's return value.
 * Names up to six missing items so the model can tell the user what to
 * install; truncates the rest with ", and more". `unknown template` short-
 * circuits with no item list.
 */
function notReadyMessage(missing: RequiredItem[], reason?: string): string {
  if (reason === 'unknown template') {
    return 'This template can\'t be used right now. The configured default '
      + 'template was not found. Tell the user to pick a valid default in '
      + 'Settings -> Tools.';
  }
  const items = missing.slice(0, 6).map((m) => {
    if (m.kind === 'plugin') return m.repos[0]?.repo ?? m.classType ?? 'unnamed plugin';
    return m.name ?? 'unnamed model';
  });
  const more = missing.length > 6 ? ', and more' : '';
  if (items.length === 0) {
    return 'This template can\'t be used right now. Tell the user to install '
      + 'its dependencies from the Models or Plugins page.';
  }
  return `This template needs ${items.join(', ')}${more}. Tell the user to `
    + 'install them from the Models or Plugins page.';
}

export async function generateImageTool(config: GenerateImageConfig) {
  const description = await buildPerTemplateDescription(
    (config.defaultTemplate ?? '').trim(),
  );
  return defineTool({
    description,
    inputSchema,
    // Opts the tool into the GPU orchestrator (see services/chat/gpuOrchestrator.ts):
    // ComfyUI workflows fight Ollama for VRAM on co-located GPUs, so we unload
    // the LLM before submitting the prompt. Reload happens lazily on the next turn.
    unloadGpuOnUse: true,
    execute: async (rawArgs): Promise<GenerateImageOutput> => {
      // Always use the user's configured default. The model has no say —
      // see commit history / inputSchema docs for context.
      const templateName = (config.defaultTemplate ?? '').trim();
      if (!templateName) {
        return GENERATE_IMAGE_NO_TEMPLATE_ERROR;
      }
      // Execute-time readiness gate. Authoritative async check that backstops
      // the registration-time gate in tools/index.ts. Both gates run the same
      // workflow-walking dep check via `checkTemplateDependencies`; the
      // execute-time call covers the registration->execute race when a
      // dependency is removed mid-turn. No ComfyUI submission, no GPU work,
      // until the gate passes.
      const template = templates.getTemplate(templateName);
      if (!template) {
        return notReadyMessage([], 'unknown template');
      }
      const depCheck = await checkTemplateDependencies(templateName);
      if (!depCheck.ready) {
        return notReadyMessage(depCheck.missing);
      }
      try {
        const argsRecord = (rawArgs ?? {}) as Record<string, unknown>;
        const out = await submitTemplate({
          templateName,
          inputs: argsRecord,
          provenance: {
            triggeredBy: 'chat',
            conversationId: config.conversationId,
            messageId: config.messageId,
          },
        });
        const fieldNote = out.fieldId
          ? GENERATE_IMAGE_PROMPT_FIELD_NOTE(out.fieldId)
          : GENERATE_IMAGE_NO_FIELD_NOTE;
        const text = GENERATE_IMAGE_QUEUED_RESULT({
          templateName: out.templateName,
          promptId: out.promptId,
          fieldNote,
        });
        return { text, promptId: out.promptId, templateName: out.templateName };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn('generate_image tool failed', { template: templateName, error: msg });
        return GENERATE_IMAGE_FAILED_PREFIX + msg;
      }
    },
  });
}
