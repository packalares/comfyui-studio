// Zod schemas for the /api/system aggregate endpoint and related shapes.
// TODO Wave 4: split GET /api/system into /api/system/stats, /api/system/queue, etc.

import { z } from 'zod';

export const QueueStatusSchema = z.object({
  queue_running: z.number().int().nonnegative(),
  queue_pending: z.number().int().nonnegative(),
});

export const DashboardSummarySchema = z.object({
  modelsInstalled: z.number().int().nonnegative().nullable(),
  pluginsInstalled: z.number().int().nonnegative().nullable(),
  pluginHistory: z.array(z.unknown()),
});

export const NetworkReachabilitySchema = z.object({
  url: z.string(),
  accessible: z.boolean(),
  latencyMs: z.number().optional(),
});

export const NetworkConfigViewSchema = z.object({
  huggingfaceEndpoint: z.string(),
  githubProxy: z.string(),
  pipSource: z.string(),
  pluginTrustedHosts: z.array(z.string()),
  modelTrustedHosts: z.array(z.string()),
  allowPrivateIpMirrors: z.boolean(),
  reachability: z.object({
    github: NetworkReachabilitySchema,
    pip: NetworkReachabilitySchema,
    huggingface: NetworkReachabilitySchema,
  }),
});

export const ChatAdvancedSettingsSchema = z.object({
  highWaterPercent: z.number(),
  maxToolSteps: z.number().int().positive(),
  loadingHintMs: z.number().int().nonnegative(),
  keepRecent: z.number().int().nonnegative(),
  titleTimeoutMs: z.number().int().positive(),
  summaryTimeoutMs: z.number().int().positive(),
  smartSuggestions: z.boolean(),
});

export const ChatToolListingSchema = z.object({
  name: z.string(),
  label: z.string(),
  description: z.string(),
});

export const McpToolListingSchema = z.record(z.string(), z.unknown());

export const ChatToolsSettingsSchema = z.object({
  searxngUrl: z.string(),
  defaultImageTemplate: z.string(),
  enabledMcpTools: z.record(z.string(), z.boolean()),
  mcpToolListings: z.unknown(),
  studioMcp: z.unknown(),
  availableTools: z.array(ChatToolListingSchema),
});

export const ChatSuggestionsViewSchema = z.object({
  emptyState: z.array(z.string()),
  contextual: z.object({
    codeFenced: z.array(z.string()),
    question: z.array(z.string()),
    urlBearing: z.array(z.string()),
    fallback: z.array(z.string()),
    longReplyExtra: z.string(),
  }),
});

export const ChatSettingsViewSchema = z.object({
  ollamaUrl: z.string(),
  defaultModel: z.string(),
  keepAlive: z.string(),
  defaultContextStrategy: z.enum(['sliding', 'auto']),
  defaultThinkMode: z.enum(['on', 'off', 'auto']),
  advanced: ChatAdvancedSettingsSchema,
  tools: ChatToolsSettingsSchema,
  suggestions: ChatSuggestionsViewSchema,
});

export const PendingEditSchema = z.object({
  id: z.string(),
  soulName: z.string(),
  reason: z.string(),
  currentSection: z.string().nullable(),
  proposedReplacement: z.string(),
  createdAt: z.number(),
});

export const PersonalitySoulSchema = z.object({ name: z.string(), description: z.string() });
export const PersonalitySkillSchema = z.object({ name: z.string(), description: z.string(), scripts: z.array(z.string()) });
export const PersonalityCommandSchema = z.object({ name: z.string(), description: z.string(), argumentHint: z.string() });

export const PersonalitySummarySchema = z.object({
  souls: z.array(PersonalitySoulSchema),
  skills: z.array(PersonalitySkillSchema),
  commands: z.array(PersonalityCommandSchema),
  defaultSoul: z.string().nullable(),
  edits: z.array(PendingEditSchema),
});

export const GalleryItemLiteSchema = z.record(z.string(), z.unknown());

export const SystemResponseSchema = z.object({
  // ComfyUI system_stats fields forwarded verbatim
  system: z.record(z.string(), z.unknown()).optional(),
  devices: z.unknown().optional(),
  // Studio-owned fields
  queue: QueueStatusSchema.nullable(),
  comfyuiConnected: z.boolean(),
  network: NetworkConfigViewSchema.nullable(),
  chat: ChatSettingsViewSchema,
  personality: PersonalitySummarySchema,
  gallery: z.object({
    total: z.number().int().nonnegative(),
    recent: z.array(GalleryItemLiteSchema),
  }),
  summary: DashboardSummarySchema,
  apiKeyConfigured: z.boolean(),
  hfTokenConfigured: z.boolean(),
  civitaiTokenConfigured: z.boolean(),
  githubTokenConfigured: z.boolean(),
  pexelsApiKeyConfigured: z.boolean(),
  uploadMaxBytes: z.number().int().positive(),
}).passthrough(); // ComfyUI stat blob is passthrough

// Legacy TS-only types preserved for service layer compatibility
export interface QueueStatus { queue_running: number; queue_pending: number; }
export interface DashboardSummary { modelsInstalled: number | null; pluginsInstalled: number | null; pluginHistory: unknown[]; }
export interface SystemInfo { queue: QueueStatus | null; gallery: { total: number; recent: unknown[] }; summary: DashboardSummary; [key: string]: unknown; }
export interface LauncherStatus {
  reachable?: boolean;
  status?: number | string;
  uptime?: string;
  error?: string;
  running?: boolean;
  pid?: number;
  gpuMode?: string;
  versions?: { comfyui?: string; frontend?: string; launcher?: string };
  [key: string]: unknown;
}
export interface DownloadState { taskId: string; modelName?: string; filename?: string; progress: number; currentModelProgress: number; totalBytes: number; downloadedBytes: number; speed: number; status: string; completed: boolean; error: string | null; }
export interface DownloadIdentity { modelName?: string; filename?: string; }
