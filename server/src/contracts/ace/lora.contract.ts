// Zod schemas for the ACE-Step LoRA control routes:
// POST /api/ace/lora/load, /unload, /scale, /toggle, GET /status.
// These hit the resident ACE-Step FastAPI directly (`services/ace/acestep.ts`'s
// `loadLora`/`unloadLora`/`setLoraScale`/`toggleLora`/`getLoraStatus`).

import { z } from 'zod';

export const LoraLoadBodySchema = z.object({
  lora_path: z.string().min(1),
  adapter_name: z.string().optional(),
});

export const LoraLoadResponseSchema = z.object({
  message: z.string(),
  lora_path: z.string(),
  loaded: z.boolean(),
});

export const LoraUnloadResponseSchema = z.object({
  message: z.string(),
});

export const LoraScaleBodySchema = z.object({
  scale: z.number().min(0).max(1),
  adapter_name: z.string().optional(),
});

export const LoraScaleResponseSchema = z.object({
  message: z.string(),
  scale: z.number(),
});

export const LoraToggleBodySchema = z.object({
  enabled: z.boolean().default(true),
});

export const LoraToggleResponseSchema = z.object({
  message: z.string(),
  active: z.boolean(),
});

export const LoraStatusResponseSchema = z.object({
  loaded: z.boolean().default(false),
  active: z.boolean().default(false),
  scale: z.number().default(1.0),
});
