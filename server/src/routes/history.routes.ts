// ComfyUI history proxy + cache-hit resolver.
//
// `/history/:promptId` flattens the upstream per-node output bag into a
// single array, tagging each file with a `mediaType` from its extension.
// When ComfyUI reports `execution_cached` covering every node in the
// submitted workflow, the upstream history has `outputs: {}` — no files
// were written because everything came from cache. In that case we:
//
//   1. Canonical-hash the prompt.
//   2. Look up the gallery row(s) with the same hash from a PRIOR run.
//   3. Return those rows' filenames as the "current" outputs.
//
// If the hash has no matching gallery row (original was deleted), we
// return `cacheOrphaned: true` so the client can stop the progress spinner
// and surface a clear error instead of hanging at "Generating…".

import { Router, type Request, type Response } from 'express';
import * as comfyui from '../services/comfyui.js';
import { workflowHash, isFullCacheHit } from '../lib/workflowHash.js';
import { findByWorkflowHash } from '../lib/db/gallery.repo.js';
import { normalisePromptField } from '../services/gallery.rowBuilder.js';

const router = Router();

interface FlatOutput {
  filename: string;
  subfolder: string;
  type: string;
  mediaType: string;
}

function flattenOutputs(
  nodeMap: Record<string, Record<string, unknown>>,
): FlatOutput[] {
  const out: FlatOutput[] = [];
  for (const nodeOutput of Object.values(nodeMap || {})) {
    for (const f of comfyui.collectNodeOutputFiles(nodeOutput)) {
      out.push({
        filename: f.filename,
        subfolder: f.subfolder || '',
        type: f.type || 'output',
        mediaType: comfyui.detectMediaType(f.filename),
      });
    }
  }
  return out;
}

router.get('/history', async (_req: Request, res: Response) => {
  try {
    const history = await comfyui.getHistory();
    res.json(history);
  } catch {
    res.json({});
  }
});

router.get('/history/:promptId', async (req: Request, res: Response) => {
  try {
    const promptId = req.params.promptId as string;
    const data = await comfyui.fetchComfyUI<
      Record<string, {
        outputs?: Record<string, Record<string, unknown>>;
        prompt?: unknown;
        status?: { messages?: unknown };
      }>
    >(`/api/history/${promptId}`);
    const entry = data[promptId];
    if (!entry) {
      res.json({ outputs: [] });
      return;
    }

    // Happy path: ComfyUI wrote real outputs.
    const outputs = flattenOutputs(entry.outputs || {});
    if (outputs.length > 0) {
      res.json({ outputs });
      return;
    }

    // Cache-hit path: outputs empty. Check `execution_cached` in status
    // messages covers every workflow node → synthesize outputs from the
    // gallery row of the prior uncached run.
    const apiPrompt = normalisePromptField(entry.prompt);
    if (isFullCacheHit(entry.status?.messages, apiPrompt as Record<string, unknown> | null)) {
      const hash = workflowHash(apiPrompt);
      const prior = hash ? findByWorkflowHash(hash, 10) : [];
      if (prior.length > 0) {
        const cachedOutputs: FlatOutput[] = prior.map(r => ({
          filename: r.filename,
          subfolder: r.subfolder || '',
          type: r.type || 'output',
          mediaType: r.mediaType,
        }));
        res.json({ outputs: cachedOutputs, cached: true });
        return;
      }
      // Cache hit but no matching gallery row — the prior result was
      // deleted, so there's nothing to show. Surface this distinctly so
      // the client can stop waiting and toast the user.
      res.json({
        outputs: [],
        cached: true,
        cacheOrphaned: true,
        reason: 'Cached result unavailable — the original output was deleted from the gallery. Modify the prompt or clear the ComfyUI cache to regenerate.',
      });
      return;
    }

    // Still running / too early — client will re-poll on the next WS
    // event per the existing logic. Unchanged behaviour.
    res.json({ outputs: [] });
  } catch {
    res.json({ outputs: [] });
  }
});

export default router;
