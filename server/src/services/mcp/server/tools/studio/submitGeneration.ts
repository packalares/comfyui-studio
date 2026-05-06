// Studio MCP tool: submit a generation job via a Studio template.

import { z } from 'zod';
import { submitTemplate } from '../../../../templates/submitTemplate.js';

export const description =
  'Submit a generation job using a Studio template. Returns a promptId for polling.';

export const inputShape = {
  templateName: z.string().min(1).describe('Template slug to run'),
  inputs: z.object({
    prompt: z.string().min(1).describe('Text prompt passed to the workflow'),
  }).passthrough().describe(
    'Generation inputs. Always include `prompt`. Additional keys are mapped to matching widget names.',
  ),
};

export interface SubmitGenerationArgs {
  templateName: string;
  inputs: { prompt: string; [k: string]: unknown };
}

export async function run(args: SubmitGenerationArgs): Promise<unknown> {
  return await submitTemplate({
    templateName: args.templateName,
    inputs: args.inputs,
    provenance: { triggeredBy: 'mcp' },
  });
}
