// Studio MCP tool: submit a generation job via a Studio template.
//
// `templateName` is fuzzy-resolved (the LLM often passes a guessed display
// title rather than the slug) — an exact slug or single match runs; an
// ambiguous reference returns candidates without submitting.
//
// When called from the chat path (`ctx.messageId` is present), attachment-
// backed upload fields are resolved automatically from the conversation's
// chat_attachments rows. From an external MCP client (no ctx) the attachment
// step is skipped.

import { z } from 'zod';
import { submitTemplate } from '../../../../templates/submitTemplate.js';
import { resolveAttachmentTemplateInputs } from '../../../../chat/attachmentTemplateInputs.js';
import {
  resolveTemplateName,
  unresolvedTemplateError,
  ambiguousTemplateError,
} from '../../../../templates/resolveTemplateName.js';

export const description =
  'Submit a generation job using a Studio template. Returns a promptId for polling. '
  + 'Pass the `name` from studio_list_templates as `templateName`; a title or partial name is fuzzy-matched.';

export const inputShape = {
  templateName: z.string().min(1).describe(
    'Template name (the `name` from studio_list_templates). A title or partial name is fuzzy-matched.',
  ),
  inputs: z.object({
    prompt: z.string().min(1).describe('Text prompt passed to the workflow'),
  }).passthrough().describe(
    'Generation inputs. Always include `prompt`. Additional keys are mapped to matching widget names. '
    + 'Image/mask/audio/video inputs are filled automatically from files attached in the conversation.',
  ),
};

export interface SubmitGenerationArgs {
  templateName: string;
  inputs: { prompt: string; [k: string]: unknown };
}

export interface SubmitGenerationContext {
  conversationId?: string;
  messageId?: string;
}

export async function run(
  args: SubmitGenerationArgs,
  ctx?: SubmitGenerationContext,
): Promise<unknown> {
  const resolved = resolveTemplateName(args.templateName);
  if (!resolved) return unresolvedTemplateError(args.templateName);
  if ('candidates' in resolved) return ambiguousTemplateError(args.templateName, resolved.candidates);
  const templateName = resolved.name;

  // Attachment resolution: only on the chat path (messageId available).
  // External MCP clients skip this step.
  const mergedInputs: Record<string, unknown> = { ...args.inputs };
  if (ctx?.messageId) {
    const attachResult = await resolveAttachmentTemplateInputs({
      templateName,
      conversationId: ctx.conversationId,
      messageId: ctx.messageId,
    });
    if (attachResult.unmatchedRequiredFields.length > 0) {
      const labels = attachResult.unmatchedRequiredFields.join(', ');
      return `This template needs you to attach: ${labels}. Please attach the file(s) and try again.`;
    }
    Object.assign(mergedInputs, attachResult.filledInputs);
  }

  const out = await submitTemplate({
    templateName,
    inputs: mergedInputs,
    provenance: {
      triggeredBy: ctx?.messageId ? 'chat' : 'mcp',
      conversationId: ctx?.conversationId,
      messageId: ctx?.messageId,
    },
  });
  return {
    ...out,
    ...(templateName !== args.templateName ? { resolvedFrom: args.templateName } : {}),
  };
}
