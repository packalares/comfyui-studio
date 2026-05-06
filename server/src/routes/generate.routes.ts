// Generate endpoint — thin handler that delegates to `submitTemplate`.
// Fix 3: the prior inline pipeline (proxyOverrides → workflowToApiPrompt →
// applyNodeOverrides → submitPrompt) is replaced by a single `submitTemplate`
// call so snapshot, provenance, and fingerprint logic runs for all entry points.

import { Router, type Request, type Response } from 'express';
import * as comfyui from '../services/comfyui.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { sendError } from '../middleware/errors.js';
import { submitTemplate } from '../services/templates/submitTemplate.js';

const router = Router();

// 60 req/min per IP.
const generateLimiter = rateLimit({ windowMs: 60_000, max: 60 });

interface NodeErrorRow {
  nodeId: string;
  classType?: string;
  message: string;
  details?: string;
}

function parseComfyValidation(body: string): {
  summary: string;
  nodeErrors: NodeErrorRow[];
} | null {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as {
    error?: { message?: string; type?: string };
    node_errors?: Record<string, {
      errors?: Array<{ message?: string; details?: string; type?: string }>;
      class_type?: string;
    }>;
  };
  const summary = p.error?.message || p.error?.type || 'Workflow validation failed';
  const nodeErrors: NodeErrorRow[] = [];
  if (p.node_errors && typeof p.node_errors === 'object') {
    for (const [nodeId, info] of Object.entries(p.node_errors)) {
      const classType = info?.class_type;
      for (const e of info?.errors ?? []) {
        nodeErrors.push({
          nodeId,
          classType,
          message: e?.message || e?.type || 'Invalid input',
          details: e?.details,
        });
      }
    }
  }
  if (nodeErrors.length === 0 && !p.error) return null;
  return { summary, nodeErrors };
}

router.post('/generate', generateLimiter, async (req: Request, res: Response) => {
  try {
    const { templateName, inputs: userInputs, advancedSettings } = req.body;
    if (!templateName) {
      res.status(400).json({ error: 'templateName is required' });
      return;
    }
    const result = await submitTemplate({
      templateName,
      inputs: userInputs || {},
      advancedSettings,
      provenance: { triggeredBy: 'ui' },
    });
    // Preserve prior response shape: { prompt_id, ... } that frontend expects.
    res.json({ prompt_id: result.promptId, promptId: result.promptId, templateName: result.templateName, fieldId: result.fieldId });
  } catch (err) {
    if (err instanceof comfyui.ComfyUIHttpError) {
      const parsed = parseComfyValidation(err.body);
      if (parsed && err.status >= 400 && err.status < 500) {
        res.status(400).json({ error: parsed.summary, nodeErrors: parsed.nodeErrors, upstreamStatus: err.status });
        return;
      }
      res.status(502).json({ error: 'ComfyUI rejected the prompt', detail: err.body.slice(0, 500) || err.message, upstreamStatus: err.status });
      return;
    }
    sendError(res, err, 500, 'Generation failed');
  }
});

export default router;
