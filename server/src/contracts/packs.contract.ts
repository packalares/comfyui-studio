// Zod schemas for the capability-pack routes: GET /api/packs,
// POST /api/packs/:id/install, POST /api/packs/:id/uninstall,
// GET /api/packs/progress/:taskId, GET/PATCH /api/packs/:id/settings,
// POST /api/packs/:id/models/:modelId/download,
// DELETE /api/packs/:id/models/:modelId.

import { z } from 'zod';

export const PackIdSchema = z.enum(['ace-step', 'ai-toolkit']);

export const PackSchema = z.object({
  id: PackIdSchema,
  label: z.string(),
  description: z.string(),
  installed: z.boolean(),
  version: z.string().nullable(),
  installedAt: z.number().nullable(),
});

export const PackListResponseSchema = z.object({
  items: z.array(PackSchema),
});

export const PackParamsSchema = z.object({
  id: z.string().min(1),
});

export const PackTaskStartedSchema = z.object({
  taskId: z.string(),
});

export const PackTaskParamsSchema = z.object({
  taskId: z.string().min(1),
});

export const PackTaskProgressSchema = z.object({
  taskId: z.string(),
  packId: z.string(),
  type: z.enum(['install', 'uninstall', 'model-download']),
  progress: z.number(),
  completed: z.boolean(),
  message: z.string().optional(),
  logs: z.array(z.string()),
});

/** `GET /packs/tasks` — every in-flight (or just-completed, within its grace
 *  window) install/uninstall task. This is the reconciliation path a client
 *  hits on mount: the `packId -> taskId` map only ever lived in React state
 *  on `Packs.tsx`, so a refresh needs this to know what's still running. */
export const PackTaskListResponseSchema = z.object({
  items: z.array(PackTaskProgressSchema),
});

// ---- Per-pack settings (selectable models + overrides) ----
// See services/packs/settings.ts + services/packs/registry.ts's PackModelDef.

export const PackModelKindSchema = z.enum(['checkpoint', 'whisper', 'tts', 'llm', 'lm']);

export const PackModelStateSchema = z.enum(['absent', 'downloading', 'downloaded', 'failed']);

export const PackModelSettingsSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  kind: PackModelKindSchema,
  sizeGb: z.number(),
  defaultRepo: z.string(),
  effectiveRepo: z.string(),
  repoOverride: z.string().nullable(),
  defaultSelected: z.boolean(),
  selected: z.boolean(),
  state: PackModelStateSchema,
  dest: z.string(),
  sizeBytes: z.number().nullable(),
  downloadedAt: z.number().nullable(),
});

/** Documented metadata for a known `pack_settings` key — see
 *  `services/packs/registry.ts`'s `PackSettingDef`. */
export const PackSettingDefSchema = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string(),
  tooltip: z.string(),
  kind: z.enum(['ollama-model', 'text', 'textarea']),
  placeholder: z.string().optional(),
  /** Code-level default for a `textarea` setting, so the UI can show what is
   *  in effect while unset and offer a one-click reset. */
  defaultValue: z.string().optional(),
});

export const PackSettingsResponseSchema = z.object({
  packId: PackIdSchema,
  models: z.array(PackModelSettingsSchema),
  settings: z.record(z.string(), z.string()),
  settingDefs: z.array(PackSettingDefSchema),
});

export const PackModelParamsSchema = z.object({
  id: z.string().min(1),
  modelId: z.string().min(1),
});

/** `PATCH /packs/:id/settings` body. `models[modelId]` entries only need to
 *  carry the field(s) being changed; omitting `selected`/`repoOverride`
 *  leaves that field untouched, `null` resets it to the registry default. */
export const PackSettingsPatchBodySchema = z.object({
  models: z.record(
    z.string(),
    z.object({
      selected: z.boolean().nullable().optional(),
      repoOverride: z.string().nullable().optional(),
    }),
  ).optional(),
  settings: z.record(z.string(), z.string().nullable()).optional(),
});

export const PackModelDownloadResponseSchema = z.object({
  taskId: z.string(),
});

export const PackModelRemoveResponseSchema = z.object({
  dest: z.string(),
  removed: z.boolean(),
});
