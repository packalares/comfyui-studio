// Studio MCP tool: poll status of a submitted generation job.

import { z } from 'zod';
import { getQueuePromptIds, getHistoryForPrompt } from '../../../../comfyui.js';
import * as galleryRepo from '../../../../../lib/db/gallery.repo.js';

export const description =
  'Get the current state of a generation job. Returns state, optional progress, and outputs.';

export const inputShape = {
  promptId: z.string().min(1).describe('Prompt ID returned by submitGeneration'),
};

export interface GetJobStatusArgs {
  promptId: string;
}

type JobState = 'queued' | 'running' | 'done' | 'error';

export async function run(args: GetJobStatusArgs): Promise<unknown> {
  let state: JobState = 'queued';
  let outputs: unknown[] = [];

  let activeIds: Set<string>;
  try {
    activeIds = await getQueuePromptIds();
  } catch {
    activeIds = new Set();
  }

  if (activeIds.has(args.promptId)) {
    state = 'running';
  } else {
    try {
      const entry = await getHistoryForPrompt(args.promptId);
      if (entry) {
        const messages = entry.status?.messages ?? [];
        const hasError = (messages as Array<[string, unknown]>).some(
          (m) => Array.isArray(m) && m[0] === 'execution_error',
        );
        state = hasError ? 'error' : 'done';
      }
    } catch { /* fall through */ }

    if (state === 'done') {
      const rows = galleryRepo.listByPromptIds([args.promptId]);
      outputs = rows.map((r) => ({
        id: r.id,
        filename: r.filename,
        mediaType: r.mediaType,
        url: r.url,
      }));
    }
  }

  return { state, outputs };
}
