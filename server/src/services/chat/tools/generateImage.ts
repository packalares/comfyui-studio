// `generate_image` chat tool — submits Studio's existing template-based
// generate flow (`POST /api/generate` shares the same code path) and returns
// the resulting `prompt_id`. Image delivery is deferred: ComfyUI runs the
// workflow asynchronously; the gallery sentry persists the row when it
// finishes; the existing UI gallery / WS channel surfaces the asset.
//
// v1 limitation: this tool returns immediately with the prompt id; it does
// NOT block waiting for the image URL. Per the phase-2 task, the chat UI
// can subscribe to gallery events to inject the finished asset later.

import { tool } from 'ai';
import { z } from 'zod';
import * as comfyui from '../../comfyui.js';
import * as templates from '../../templates/index.js';
import type { FormInputData, RawTemplate } from '../../templates/types.js';
import { generateFormInputs } from '../../templates/templates.formInputs.js';
import { getObjectInfo, workflowToApiPrompt } from '../../workflow/index.js';
import { schedulePromptWatch } from '../../gallery.sentry.js';
import { env } from '../../../config/env.js';
import { logger } from '../../../lib/logger.js';
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
}

const inputSchema = z.object({
  prompt: z.string().min(1)
    .describe('Text prompt for the image. Routed to the template\'s primary '
      + 'prompt input field.'),
  template: z.string().optional()
    .describe('Optional Studio template name. When omitted, the user\'s '
      + 'configured default image template is used. Must be one of the '
      + 'templates listed under category "image" in Studio.'),
});

// Pick the prompt-bearing field. Templates with explicit form bindings put a
// `text`/`textarea` field first; legacy ones use a tag-only `prompt` fallback
// also typed as `text`. Either way the heuristic is "first text-shaped form
// input" — same rule the Studio UI uses to render the prompt textarea.
function pickPromptField(fields: FormInputData[]): FormInputData | null {
  return fields.find((f) => f.type === 'text' || f.type === 'textarea') ?? null;
}

interface SubmitArgs {
  templateName: string;
  prompt: string;
}

interface SubmitResult {
  promptId: string;
  templateName: string;
  fieldId: string | null;
}

async function submitTemplate(args: SubmitArgs): Promise<SubmitResult> {
  const template = templates.getTemplate(args.templateName);
  if (!template) {
    throw new Error(`unknown template "${args.templateName}"`);
  }
  // Source the workflow JSON the same way the /api/generate route does:
  // user-imported templates live on local disk, everything else is fetched
  // from ComfyUI.
  let workflow: Record<string, unknown>;
  if (templates.isUserWorkflow(args.templateName)) {
    const local = templates.getUserWorkflowJson(args.templateName);
    if (!local) throw new Error('user workflow file missing');
    workflow = local;
  } else {
    const wfRes = await fetch(
      `${env.COMFYUI_URL}/templates/${encodeURIComponent(args.templateName)}.json`,
    );
    if (!wfRes.ok) throw new Error(`workflow fetch ${wfRes.status}`);
    workflow = await wfRes.json() as Record<string, unknown>;
  }
  const rawForBindings: RawTemplate = {
    name: args.templateName,
    title: template.title,
    description: template.description,
    mediaType: template.mediaType,
    tags: template.tags,
    models: template.models,
    io: template.io,
  };
  const objectInfo = await getObjectInfo();
  const formInputs = generateFormInputs(rawForBindings, workflow, objectInfo);
  const promptField = pickPromptField(formInputs);
  // The injector expects `userInputs` keyed by form-field id. When no
  // prompt-shaped field exists we still submit — the workflow's defaults
  // run, and the LLM gets a clear "no prompt field" hint in the result.
  const userInputs: Record<string, unknown> = {};
  if (promptField) userInputs[promptField.id] = args.prompt;
  const apiPrompt = await workflowToApiPrompt(workflow, userInputs, formInputs);
  const attachApiKey = template.openSource === false;
  const result = await comfyui.submitPrompt(apiPrompt, { attachApiKey });
  if (!result?.prompt_id) {
    throw new Error('comfyui did not return a prompt_id');
  }
  // Match the /api/generate route — sentry catches completion if the WS event
  // path misses the corresponding `execution_success`.
  schedulePromptWatch(result.prompt_id);
  return {
    promptId: result.prompt_id,
    templateName: args.templateName,
    fieldId: promptField?.id ?? null,
  };
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

export function generateImageTool(config: GenerateImageConfig) {
  return tool({
    description: TOOL_DESCRIPTION_GENERATE_IMAGE,
    inputSchema,
    execute: async ({ prompt, template }): Promise<GenerateImageOutput> => {
      // LLMs frequently hallucinate template names ("cyberpunk-city" etc).
      // If the model-supplied name doesn't resolve, silently fall back to the
      // user's configured default rather than failing the tool call.
      const requested = (template ?? '').trim();
      const fallback = (config.defaultTemplate ?? '').trim();
      const requestedExists = requested.length > 0
        && templates.getTemplate(requested) !== undefined;
      const templateName = requestedExists ? requested : fallback;
      if (!templateName) {
        return GENERATE_IMAGE_NO_TEMPLATE_ERROR;
      }
      try {
        const out = await submitTemplate({ templateName, prompt });
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
