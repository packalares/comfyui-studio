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
import rateLimit from 'express-rate-limit';
import { request as undiciRequest, Agent } from 'undici';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { registerSpecOnly } from '../lib/defineRoute.js';
import { getOllamaUrl, getLlmApiQueueLimit, getDocscannerUrl } from '../services/settings/index.js';
import { submitGpuJob, scheduler } from '../services/gpu/scheduler.js';
import { processLlmAttachments, AttachmentError } from '../services/llm/attachments.js';
import { parseDocscannerField, scanRequestImages, DocscannerError } from '../services/llm/docscanner.js';
import { maybeInlinePdfImages } from '../services/llm/pdfVision.js';
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

// Emit an error in the shape the caller expects: OpenAI clients want
// `{error:{message,type,code}}`; Ollama-native clients want `{error:"..."}`.
function sendLlmError(
  res: Response, mode: 'ollama' | 'openai', status: number, code: string, message: string,
): void {
  if (res.headersSent) return;
  const body = mode === 'openai'
    ? { error: { message, type: code, code } }
    : { error: message };
  res.status(status).json(body);
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
  // Ollama streams by default (stream !== false); OpenAI /v1 does NOT
  // (stream must be explicitly true). The response framing differs too:
  // Ollama = NDJSON, OpenAI = SSE (text/event-stream).
  mode: 'ollama' | 'openai' = 'ollama',
): Promise<void> {
  // Only the public API surface (nginx stamps X-Studio-Public) is subject to
  // backpressure + attachment ingestion; internal UI/enhancer calls pass through.
  const isPublic = req.header('x-studio-public') === '1';

  // Public backpressure: if the GPU queue is already deep, fail fast with a
  // busy error instead of piling on. Bounds latency under load.
  if (isPublic) {
    const depth = scheduler.snapshot().queue.length;
    const limit = getLlmApiQueueLimit();
    if (depth >= limit) {
      sendLlmError(res, mode, 429, 'server_busy',
        `Server busy (${depth} request(s) queued). Please retry shortly.`);
      return;
    }
  }

  // docscanner: optimize vision images (opt-in via the `docscanner` field +
  // a configured DocScanner URL). Replaces each image in place; scan_only
  // returns the cleaned image and skips the model.
  const ds = parseDocscannerField(body);
  try { delete (body as Record<string, unknown>).docscanner; } catch { /* frozen? ignore */ }
  if (ds.enabled && getDocscannerUrl()) {
    try {
      const { count, first } = await scanRequestImages(body, ds.config);
      if (ds.scanOnly) {
        if (!first) {
          sendLlmError(res, mode, 400, 'no_image',
            'docscanner scan_only was requested but no image was found in the request.');
          return;
        }
        if (!res.headersSent) res.status(200).json({ image_b64: first.image_b64, format: first.format });
        return;
      }
      void count;
    } catch (err) {
      if (err instanceof DocscannerError) { sendLlmError(res, mode, 502, err.code, err.message); return; }
      sendLlmError(res, mode, 500, 'docscanner_error', err instanceof Error ? err.message : String(err));
      return;
    }
  }

  // Fast path: if the model is vision-capable and an attached PDF is scanned +
  // small, render its pages to images and attach them directly (one vision call
  // instead of Docling OCR'ing every page). Inlined PDFs are removed from the
  // body so the Docling step below skips them. Non-fatal: on any failure the
  // PDF is left in place for Docling.
  try {
    await maybeInlinePdfImages(body, mode);
  } catch (err) {
    logger.warn('pdfVision inline failed; falling back to docling', { error: String(err) });
  }

  // Document ingestion: extract any attachments → text via Docling, inject into
  // the prompt, enforce the input-token budget, and raise num_ctx (native).
  try {
    await processLlmAttachments(body, mode);
  } catch (err) {
    if (err instanceof AttachmentError) {
      sendLlmError(res, mode, err.status, err.code, err.message);
      return;
    }
    sendLlmError(res, mode, 500, 'attachment_error', err instanceof Error ? err.message : String(err));
    return;
  }

  const upstream = getOllamaUrl();

  // Detect streaming intent; embeddings endpoint is always non-streaming.
  const streamField = (body as Record<string, unknown>).stream;
  const isStream = taskType !== 'llm-embeddings'
    && (mode === 'openai' ? streamField === true : streamField !== false);

  // For streaming, commit response headers + a newline every 30s WHILE waiting
  // in the GPU queue so intermediate proxies (nginx, cloudflare) don't close
  // the idle connection. NDJSON parsers ignore blank lines, so this is a safe
  // no-op event. Cleared the moment the scheduler hands us the slot.
  let queueHeartbeat: NodeJS.Timeout | null = null;
  if (isStream) {
    res.setHeader('Content-Type', mode === 'openai' ? 'text/event-stream' : 'application/x-ndjson');
    res.setHeader('Transfer-Encoding', 'chunked');
    // Tell nginx (and any reverse proxy honouring the convention) to NOT
    // buffer this response. With default `proxy_buffering on`, nginx-ingress
    // holds our `\n` heartbeats until it has accumulated a buffer's worth,
    // which means the client doesn't see them at all during Ollama's cold
    // load and the connection looks idle to the proxy's own watchdog →
    // 504 Gateway Timeout even though Studio is correctly waiting upstream.
    res.setHeader('X-Accel-Buffering', 'no');
    // Cache-Control: no-transform additionally hints to intermediaries
    // (CDNs, compression layers) not to gzip or rebuffer.
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.status(200);
    res.flushHeaders();
    queueHeartbeat = setInterval(() => {
      if (!res.writableEnded) res.write('\n');
    }, 15_000);
  }

  const traceId = Math.random().toString(36).slice(2, 8);
  logger.info(`[llm:${traceId}] submit task=${taskType} stream=${isStream}`);
  try {
    await submitGpuJob(taskType, async (release) => {
      logger.info(`[llm:${traceId}] slot granted, dispatching to ${upstream}${targetPath}`);
      const ac = new AbortController();
      const onClose = () => { ac.abort(); };
      req.on('close', onClose);

      try {
        const t0 = Date.now();
        // NOTE: we used to pass `dispatcher: ollamaAgent` (shared keep-alive
        // pool) for connection reuse, but that surfaced a heisenbug where
        // streaming chat responses would have headers arrive promptly yet
        // `response.body`'s async iterator would never yield a chunk. The
        // connection was a stale half-open keep-alive socket from a prior
        // streamed request that never cleaned up. Falling back to the
        // global dispatcher (fresh socket per request) eliminates the
        // hang at the cost of one TCP handshake per call (~ms inside the
        // cluster — well below the streaming budget).
        const response = await undiciRequest(`${upstream}${targetPath}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
        logger.info(`[llm:${traceId}] upstream headers in ${Date.now() - t0}ms status=${response.statusCode}`);

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
          // Manual chunk loop instead of stream.pipeline so we log every
          // chunk Ollama sends — surfaces whether response.body is actually
          // producing bytes (vs the pipeline silently swallowing them).
          let chunks = 0;
          let bytes = 0;
          try {
            for await (const chunk of response.body) {
              chunks += 1;
              bytes += chunk.length;
              if (res.writableEnded || res.destroyed) break;
              const ok = res.write(chunk);
              if (!ok) {
                // Backpressure: wait for drain BUT also bail on socket close /
                // error. If the client refreshed, the socket is gone and
                // `drain` will NEVER fire — without racing close/error here,
                // the loop hangs forever, `finally` never runs, the scheduler
                // slot stays held until the watchdog rescues it minutes later.
                await new Promise<void>((resolve) => {
                  const cleanup = (): void => {
                    res.off('drain', resolve);
                    res.off('close', resolve);
                    res.off('error', resolve);
                  };
                  res.once('drain', () => { cleanup(); resolve(); });
                  res.once('close', () => { cleanup(); resolve(); });
                  res.once('error', () => { cleanup(); resolve(); });
                });
                if (res.writableEnded || res.destroyed) break;
              }
            }
            logger.info(`[llm:${traceId}] pipeline done chunks=${chunks} bytes=${bytes}`);
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code !== 'ERR_STREAM_PREMATURE_CLOSE') {
              logger.warn(`[llm:${traceId}] pipeline error after ${chunks} chunks/${bytes} bytes`, {
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          if (!res.writableEnded) res.end();
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

// Rate limiter for the PUBLIC LLM API surface. Internal UI/enhancer calls
// (no X-Studio-Public stamp) are skipped, so this never throttles in-app chat.
// Keyed by the API key so one caller can't starve others; complements the
// GPU-queue backpressure (which bounds concurrency, not request rate).
const publicLlmLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: (req) => req.header('x-studio-public') !== '1',
  keyGenerator: (req) => req.header('authorization') ?? 'anon',
  handler: (req: Request, res: Response) => {
    const mode: 'ollama' | 'openai' = req.path.includes('/v1/') ? 'openai' : 'ollama';
    sendLlmError(res, mode, 429, 'rate_limited', 'Rate limit exceeded. Please slow down and retry.');
  },
});

const router = Router();

// ---- POST /llm/chat ----

router.post(
  '/llm/chat',
  publicLlmLimiter,
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
  publicLlmLimiter,
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
  publicLlmLimiter,
  authMiddleware({ required: true, scopes: ['chat:read'] }),
  async (req: Request, res: Response) => {
    const parsed = parseBody(LlmEmbeddingsBodySchema, req.body);
    if (!parsed.ok) { sendJsonError(res, 400, parsed.error); return; }
    await proxyToOllama(req, res, '/api/embeddings', 'llm-embeddings', parsed.data);
  },
);

// ---- OpenAI-compatible passthrough (/llm/v1/*) ----
// Bodies are OpenAI-shaped and forwarded verbatim to Ollama's native OpenAI
// endpoints. Streaming uses OpenAI semantics (stream:true → SSE). Every
// GPU-bound call runs through the SAME submitGpuJob queue as /llm/*, so a
// single GPU is never hammered. The front nginx maps public /v1/* → these.

router.post(
  '/llm/v1/chat/completions',
  publicLlmLimiter,
  authMiddleware({ required: true, scopes: ['chat:write'] }),
  async (req: Request, res: Response) => {
    if (req.body === null || typeof req.body !== 'object') { sendJsonError(res, 400, 'JSON body required'); return; }
    await proxyToOllama(req, res, '/v1/chat/completions', 'llm-chat', req.body, 'openai');
  },
);

router.post(
  '/llm/v1/completions',
  publicLlmLimiter,
  authMiddleware({ required: true, scopes: ['chat:write'] }),
  async (req: Request, res: Response) => {
    if (req.body === null || typeof req.body !== 'object') { sendJsonError(res, 400, 'JSON body required'); return; }
    await proxyToOllama(req, res, '/v1/completions', 'llm-generate', req.body, 'openai');
  },
);

router.post(
  '/llm/v1/embeddings',
  publicLlmLimiter,
  authMiddleware({ required: true, scopes: ['chat:read'] }),
  async (req: Request, res: Response) => {
    if (req.body === null || typeof req.body !== 'object') { sendJsonError(res, 400, 'JSON body required'); return; }
    await proxyToOllama(req, res, '/v1/embeddings', 'llm-embeddings', req.body, 'openai');
  },
);

// Model list is a cheap metadata call — no GPU, so it skips the scheduler.
router.get(
  '/llm/v1/models',
  publicLlmLimiter,
  authMiddleware({ required: true, scopes: ['chat:read'] }),
  async (_req: Request, res: Response) => {
    try {
      const r = await undiciRequest(`${getOllamaUrl()}/v1/models`, { method: 'GET' });
      const json = await r.body.json();
      res.status(r.statusCode).json(json);
    } catch (err) {
      sendJsonError(res, 502, err instanceof Error ? err.message : String(err));
    }
  },
);

export default router;
