// `POST /api/documents/convert` — convert an uploaded document to a chosen
// format via the docling conversion service (docling >= 1.2, /v1/convert).
//
// Formats: markdown | html | text | json | csv.
// Recognizer: dots (end-to-end, default) | paddle-vl (layout+element pipeline).
// `schema` shapes format=json extraction. All work runs in-cluster against the
// docling Service; recognition rides the Studio LLM (GPU) queue.

import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../lib/defineRoute.js';
import { convertDocument, DoclingError } from '../services/docling/client.js';
import { ConflictError, UpstreamUnavailableError, InternalError, ValidationError } from '../lib/errors.js';

export const ConvertBodySchema = z.object({
  base64: z.string().min(1),
  filename: z.string().min(1),
  format: z.enum(['markdown', 'html', 'text', 'json', 'csv']),
  recognizer: z.enum(['dots', 'paddle-vl']).optional(),
  schema: z.unknown().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
});

export const ConvertResponseSchema = z.object({
  // string for markdown/html/text/csv; object for json
  content: z.unknown(),
  format: z.string(),
  recognizer: z.string().optional(),
  pipeline: z.string().optional(),
  ms: z.number().optional(),
  warning: z.string().optional(),
});

const convertRoute = defineRoute(
  {
    method: 'POST',
    path: '/documents/convert',
    body: ConvertBodySchema,
    response: ConvertResponseSchema,
    auth: { required: true, scopes: ['chat:write'] },
    tags: ['documents'],
    summary: 'Convert a document to markdown/html/text/json/csv/tables/layout via docling',
  },
  async (ctx) => {
    const { base64, filename, format, recognizer, schema, options } = ctx.body;
    try {
      const r = await convertDocument(base64, filename, { format, recognizer, schema, options });
      return ctx.ok({
        content: r.content,
        format: r.format,
        recognizer: r.recognizer,
        pipeline: r.pipeline,
        ms: r.ms,
        warning: r.warning,
      });
    } catch (err) {
      if (err instanceof DoclingError) {
        if (err.code === 'docling_not_configured') throw new ConflictError(err.message);
        if (err.code === 'docling_too_large') throw new ValidationError(err.message);
        if (
          err.code === 'docling_upstream' ||
          err.code === 'docling_empty' ||
          err.code === 'docling_timeout'
        ) {
          throw new UpstreamUnavailableError(err.message);
        }
        throw new InternalError(err.message);
      }
      throw err;
    }
  },
);

const router = Router();
convertRoute.register(router);

export default router;
