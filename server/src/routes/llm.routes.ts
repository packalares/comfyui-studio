// Ollama drop-in compatibility proxy routes.
// POST /api/llm/chat        — proxy to Ollama /api/chat, NDJSON stream. Scope: chat:write.
// POST /api/llm/generate    — proxy to Ollama /api/generate, NDJSON stream. Scope: chat:write.
// POST /api/llm/embeddings  — proxy to Ollama /api/embeddings, single JSON. Scope: chat:read.
//
// Stream design: stream.pipeline(upstream body → res) handles backpressure + cleanup.
// ONE shared undici Agent (bounded connections) prevents a new connection per request.
// Client disconnect: req.on('close') aborts upstream via AbortController.

import { pipeline } from 'node:stream/promises';
import { Router, type Request, type Response } from 'express';
import { request as undiciRequest, Agent } from 'undici';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { registerSpecOnly } from '../lib/defineRoute.js';
import { getOllamaUrl } from '../services/settings/index.js';
import { submitGpuJob } from '../services/gpu/scheduler.js';
import { logger } from '../lib/logger.js';
import {
  LlmChatBodySchema,
  LlmGenerateBodySchema,
  LlmEmbeddingsBodySchema,
  LlmChatEventSchema,
  LlmGenerateEventSchema,
  LlmEmbeddingsResponseSchema,
} from '../contracts/llm.contract.js';

// ONE shared undici Agent for all Ollama proxy calls.
export const ollamaAgent = new Agent({ connections: 10, keepAliveTimeout: 30_000 });

// ---- OpenAPI spec registration (metadata only; runtime gating below) ----

registerSpecOnly({
  method: 'POST',
  path: '/llm/chat',
  summary: 'Proxy to Ollama /api/chat — NDJSON stream',
  tags: ['llm'],
  auth: { required: true, scopes: ['chat:write'] },
  body: LlmChatBodySchema,
  response: LlmChatEventSchema,
  responseContentType: 'application/x-ndjson',
});

registerSpecOnly({
  method: 'POST',
  path: '/llm/generate',
  summary: 'Proxy to Ollama /api/generate — NDJSON stream',
  tags: ['llm'],
  auth: { required: true, scopes: ['chat:write'] },
  body: LlmGenerateBodySchema,
  response: LlmGenerateEventSchema,
  responseContentType: 'application/x-ndjson',
});

registerSpecOnly({
  method: 'POST',
  path: '/llm/embeddings',
  summary: 'Proxy to Ollama /api/embeddings — single JSON response',
  tags: ['llm'],
  auth: { required: true, scopes: ['chat:read'] },
  body: LlmEmbeddingsBodySchema,
  response: LlmEmbeddingsResponseSchema,
});

// ---- Helpers ----

type BodyValidationError = { ok: false; error: string };
type ParsedBody<T> = { ok: true; data: T } | BodyValidationError;

function parseBody<T>(schema: z.ZodType<T>, raw: unknown): ParsedBody<T> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    return { ok: false, error: result.error.issues.map((issue) => issue.message).join('; ') };
  }
  return { ok: true, data: result.data };
}

function sendJsonError(res: Response, status: number, message: string): void {
  if (!res.headersSent) {
    res.status(status).json({ error: { code: 'validation_failed', message } });
  }
}

/**
 * Core proxy function. Wraps the upstream Ollama call in a GPU scheduler slot,
 * streams the response byte-for-byte to the client, and aborts upstream on
 * client disconnect.
 */
async function proxyToOllama(
  req: Request,
  res: Response,
  targetPath: string,
  taskType: 'llm-chat' | 'llm-generate' | 'llm-embeddings',
  body: unknown,
): Promise<void> {
  const upstream = getOllamaUrl();

  // Detect streaming intent; embeddings endpoint is always non-streaming.
  const isStream = taskType !== 'llm-embeddings'
    && (body as Record<string, unknown>).stream !== false;

  // For streaming, commit response headers + a newline every 30s WHILE waiting
  // in the GPU queue so intermediate proxies (nginx, cloudflare) don't close
  // the idle connection. NDJSON parsers ignore blank lines, so this is a safe
  // no-op event. Cleared the moment the scheduler hands us the slot.
  let queueHeartbeat: NodeJS.Timeout | null = null;
  if (isStream) {
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.status(200);
    res.flushHeaders();
    queueHeartbeat = setInterval(() => {
      if (!res.writableEnded) res.write('\n');
    }, 30_000);
  }

  try {
    await submitGpuJob(taskType, async (release) => {
      if (queueHeartbeat) { clearInterval(queueHeartbeat); queueHeartbeat = null; }
      const ac = new AbortController();

      // Abort upstream when the client disconnects.
      const onClose = () => { ac.abort(); };
      req.on('close', onClose);

      try {
        const response = await undiciRequest(`${upstream}${targetPath}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          dispatcher: ollamaAgent,
          signal: ac.signal,
        });

        if (response.statusCode < 200 || response.statusCode >= 300) {
          const errText = await response.body.text().catch(() => '');
          if (!res.headersSent) {
            res.status(response.statusCode).json({
              error: { code: 'upstream_unavailable', message: errText.slice(0, 500) || 'Ollama error' },
            });
          }
          return;
        }

        // Forward any X- or Set-Cookie headers Ollama sends back.
        const fwdHeaders: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(response.headers)) {
          if (v === undefined) continue;
          const lk = k.toLowerCase();
          if (lk.startsWith('x-') || lk === 'set-cookie' || lk === 'content-type') {
            fwdHeaders[k] = v;
          }
        }

        if (isStream) {
          res.setHeader('Content-Type', 'application/x-ndjson');
          res.setHeader('Transfer-Encoding', 'chunked');
          for (const [k, v] of Object.entries(fwdHeaders)) {
            if (k.toLowerCase() !== 'content-type') res.setHeader(k, v);
          }
          if (!res.headersSent) res.status(200);

          // BodyReadable extends Readable; pipeline handles backpressure + cleanup.
          await pipeline(response.body, res).catch((err) => {
            // Client disconnect causes ERR_STREAM_PREMATURE_CLOSE — expected.
            if ((err as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE') {
              logger.warn('[llm proxy] pipeline error', {
                error: err instanceof Error ? err.message : String(err),
              });
            }
          });
        } else {
          const json = await response.body.json();
          for (const [k, v] of Object.entries(fwdHeaders)) res.setHeader(k, v);
          if (!res.headersSent) res.status(200).json(json);
        }
      } finally {
        req.removeListener('close', onClose);
        release();
      }
    });
  } catch (err) {
    if (!res.headersSent) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('cancelled') || msg.includes('aborted')) {
        res.status(499).end(); // client closed request
      } else {
        res.status(502).json({ error: { code: 'upstream_unavailable', message: msg } });
      }
    }
  } finally {
    if (queueHeartbeat) clearInterval(queueHeartbeat);
  }
}

const router = Router();

// ---- POST /llm/chat ----

router.post(
  '/llm/chat',
  authMiddleware({ required: true, scopes: ['chat:write'] }),
  async (req: Request, res: Response) => {
    const parsed = parseBody(LlmChatBodySchema, req.body);
    if (!parsed.ok) { sendJsonError(res, 400, parsed.error); return; }
    await proxyToOllama(req, res, '/api/chat', 'llm-chat', parsed.data);
  },
);

// ---- POST /llm/generate ----

router.post(
  '/llm/generate',
  authMiddleware({ required: true, scopes: ['chat:write'] }),
  async (req: Request, res: Response) => {
    const parsed = parseBody(LlmGenerateBodySchema, req.body);
    if (!parsed.ok) { sendJsonError(res, 400, parsed.error); return; }
    await proxyToOllama(req, res, '/api/generate', 'llm-generate', parsed.data);
  },
);

// ---- POST /llm/embeddings ----

router.post(
  '/llm/embeddings',
  authMiddleware({ required: true, scopes: ['chat:read'] }),
  async (req: Request, res: Response) => {
    const parsed = parseBody(LlmEmbeddingsBodySchema, req.body);
    if (!parsed.ok) { sendJsonError(res, 400, parsed.error); return; }
    await proxyToOllama(req, res, '/api/embeddings', 'llm-embeddings', parsed.data);
  },
);

export default router;
