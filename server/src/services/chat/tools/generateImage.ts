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

export function generateImageTool(config: GenerateImageConfig) {
  return tool({
    description: 'Start an image generation in Studio using a ComfyUI '
      + 'template workflow. Returns the prompt_id immediately; the image '
      + 'will appear in the user\'s gallery when ComfyUI finishes the run. '
      + 'Tell the user to check the gallery, and quote the prompt_id so '
      + 'they can correlate.',
    inputSchema,
    execute: async ({ prompt, template }) => {
      const templateName = (template ?? config.defaultTemplate ?? '').trim();
      if (!templateName) {
        return 'generate_image failed: no template selected and no default '
          + 'image template is configured. Ask the user to set a default '
          + 'in Settings → Tools, or pass an explicit `template` argument.';
      }
      try {
        const out = await submitTemplate({ templateName, prompt });
        const fieldNote = out.fieldId
          ? ` (prompt routed to field "${out.fieldId}")`
          : ' (no prompt-shaped field on this template; defaults applied)';
        return `Image generation started.\n`
          + `template: ${out.templateName}\n`
          + `prompt_id: ${out.promptId}${fieldNote}\n`
          + 'The image will land in the user\'s gallery when ComfyUI '
          + 'finishes. Tell the user to open the Gallery page to view it.';
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn('generate_image tool failed', { template: templateName, error: msg });
        return `generate_image failed: ${msg}`;
      }
    },
  });
}
