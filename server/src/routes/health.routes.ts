// `GET /api/health` — liveness probe.
//
// First production route on the `defineRoute` foundation. Returns a tiny
// `{ status, timestamp }` envelope so external uptime checks have a stable
// machine-readable shape. No auth: probes must work without credentials.

import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../lib/defineRoute.js';

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  timestamp: z.string(),
});

const healthRoute = defineRoute({
  method: 'GET',
  path: '/health',
  response: HealthResponseSchema,
  auth: { required: false },
  tags: ['system'],
  summary: 'Liveness probe',
}, (ctx) => {
  return ctx.ok({ status: 'ok' as const, timestamp: new Date().toISOString() });
});

const router = Router();
healthRoute.register(router);

export default router;
