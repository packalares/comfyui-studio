// Zod schemas for /api/generate.

import { z } from 'zod';

export const AdvancedSettingValueSchema = z.object({
  proxyIndex: z.number().int().nonnegative(),
  value: z.unknown(),
});

export const GenerateBodySchema = z.object({
  templateName: z.string().min(1),
  inputs: z.record(z.string(), z.unknown()).default({}),
  advancedSettings: z.record(z.string(), AdvancedSettingValueSchema).optional(),
  /**
   * Optional Easy-mode hint. When provided, the submit handler looks up
   * `template.studioModes[mode]` in the TemplateData metadata: mutes the listed
   * inactive nodes (sets node.mode = 4) and writes the switch widget
   * value if present. Templates without a `modes` block ignore this.
   */
  mode: z.string().min(1).optional(),
  /**
   * Opt-out of the pre-submit model dependency check. Intended for admin
   * debugging only — normal clients should never set this.
   */
  skipDepCheck: z.boolean().optional(),
  /**
   * Wave 8: User-supplied resolutions for ambiguous model filenames. Keyed
   * by the original widget value (filename). Populated when a previous
   * generate call returned `chooserNeeded` and the UI presented a picker.
   */
  chosenResolutions: z.record(
    z.string(),
    z.object({ save_path: z.string(), filename: z.string() }),
  ).optional(),
});

export const GenerateNodeErrorSchema = z.object({
  nodeId: z.string(),
  classType: z.string().optional(),
  message: z.string(),
  details: z.string().optional(),
});

/**
 * Wave 8: One entry returned when a model filename is ambiguous (multiple
 * on-disk copies exist) and could not be auto-resolved. The UI should
 * present a picker for each entry and re-submit with `chosenResolutions`.
 */
export const ChooserCandidateSchema = z.object({
  nodeId: z.string(),
  widgetName: z.string(),
  filename: z.string(),
  candidates: z.array(z.object({
    filename: z.string(),
    save_path: z.string(),
    abs_path: z.string(),
    base_model: z.string().optional(),
  })),
});

export type ChooserCandidate = z.infer<typeof ChooserCandidateSchema>;

export const GenerateResponseSchema = z.object({
  promptId: z.string(),
  statusUrl: z.string(),   // '/api/jobs/:promptId'
  streamUrl: z.string(),   // '/api/jobs/:promptId/events'
  number: z.number().int().nonnegative().optional(),
  node_errors: z.record(z.string(), z.unknown()).optional(),
  /**
   * Wave 8: Present when one or more model filenames are ambiguous. The UI
   * must show a picker so the user can select the correct on-disk copy, then
   * re-submit with `chosenResolutions`.
   */
  chooserNeeded: z.array(ChooserCandidateSchema).optional(),
}).passthrough();
