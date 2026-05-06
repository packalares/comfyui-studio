// Assembles the chat-tool set from the on-disk integrations config. A tool is
// only exposed to the LLM when its required configuration is present (URL +
// any auth token). Empty config → tool absent from the tools map → the model
// can't call it.
//
// `getEnabledTools()` is called by `streamChat.ts` on every stream so a
// settings change takes effect on the next user turn without restarting the
// server.

import * as toolsSettings from '../../settings.tools.js';
import { checkTemplateDependencies } from '../../templates/dependencyCheck.js';
import { webSearchTool } from './webSearch.js';
import { ragSearchTool } from './ragSearch.js';
import { ragUploadTool } from './ragUpload.js';
import { generateImageTool } from './generateImage.js';
import { getMcpToolsForChat } from '../../mcp/server/toolRegistry.js';
import { snapshot as mcpClientSnapshot } from '../../mcp/client/snapshot.js';
import { TOOL_LABELS, TOOL_LABEL_DESCRIPTIONS } from '../prompts.js';
import { logger } from '../../../lib/logger.js';
import type { StudioTool } from './defineTool.js';

export type ToolName = 'web_search' | 'rag_search' | 'rag_upload' | 'generate_image';

// Each entry pairs the AI-SDK tool descriptor (consumed by `streamText` /
// `toOllamaTools`) with Studio-specific metadata (currently just
// `unloadGpuOnUse` for the GPU orchestrator). Use `unknown` generics here
// so callers don't need to handle every tool's input/output shape — the
// concrete typing lives on each `defineTool()` call site.
export type EnabledToolMap = Record<string, StudioTool>;

export interface ToolContext {
  /** Current conversation id (from the in-flight stream). */
  conversationId?: string;
  /** Current assistant message id (the placeholder created before the stream). */
  messageId?: string;
}

/**
 * `generate_image` is gated by a live workflow-walking dep check (see
 * `services/templates/dependencyCheck.ts`). The check is async + does
 * network IO, so callers of `getEnabledTools` are async too. The 5-second
 * memo inside the dep-check service keeps repeat calls within a single
 * stream cheap.
 */
export async function getEnabledTools(ctx: ToolContext = {}): Promise<EnabledToolMap> {
  const out: EnabledToolMap = {};
  const searx = toolsSettings.getSearxngUrl();
  if (searx) {
    out.web_search = webSearchTool({ baseUrl: searx });
  }
  const ragUrl = toolsSettings.getRagflowUrl();
  const ragKey = toolsSettings.getRagflowApiKey();
  if (ragUrl && ragKey) {
    out.rag_search = ragSearchTool({ baseUrl: ragUrl, apiKey: ragKey });
    out.rag_upload = ragUploadTool({ baseUrl: ragUrl, apiKey: ragKey });
  }
  const defaultImageTemplate = toolsSettings.getDefaultImageTemplate();
  if (defaultImageTemplate) {
    const dep = await checkTemplateDependencies(defaultImageTemplate);
    if (dep.ready) {
      out.generate_image = await generateImageTool({
        defaultTemplate: defaultImageTemplate,
        conversationId: ctx.conversationId,
        messageId: ctx.messageId,
      });
    }
  }

  // All 16 in-process MCP tools (10 comfy + 6 studio) — single source of truth
  // in services/mcp/server/toolRegistry. Same defs feed Studio's MCP server.
  // Only tools explicitly set to `true` in enabledMcpTools reach the LLM.
  const enabledMcpTools = toolsSettings.getEnabledMcpTools();
  const allMcpTools = getMcpToolsForChat();
  for (const [name, tool] of Object.entries(allMcpTools)) {
    if (enabledMcpTools[name] === true) out[name] = tool;
  }

  // External MCP servers (Context7, Crawl4AI, etc.) — only servers listed in
  // the active profile surface their tools to the model. Failures here are
  // non-fatal: chat continues without external tools.
  try {
    const externalTools = await mcpClientSnapshot('studio-chat-default');
    // Apply same enabledMcpTools gate to external (mcp__<server>__<name>) tools
    for (const [name, tool] of Object.entries(externalTools)) {
      if (enabledMcpTools[name] === true) out[name] = tool;
    }
  } catch (err) {
    logger.warn('MCP client snapshot failed; external tools unavailable', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return out;
}

/** Extract the AI-SDK tool records from a StudioTool map. The downstream
 *  `toOllamaTools` / `executeOllamaToolCall` helpers only consume the AI-SDK
 *  shape; the orchestrator metadata stays on the StudioTool wrapper. */
export function toAiSdkToolMap(map: EnabledToolMap): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(map)) {
    out[name] = entry.tool;
  }
  return out;
}

export async function listEnabledToolNames(): Promise<ToolName[]> {
  const names: ToolName[] = [];
  if (toolsSettings.getSearxngUrl()) names.push('web_search');
  const ragUrl = toolsSettings.getRagflowUrl();
  const ragKey = toolsSettings.getRagflowApiKey();
  if (ragUrl && ragKey) {
    names.push('rag_search');
    names.push('rag_upload');
  }
  const defaultImageTemplate = toolsSettings.getDefaultImageTemplate();
  if (defaultImageTemplate) {
    const dep = await checkTemplateDependencies(defaultImageTemplate);
    if (dep.ready) names.push('generate_image');
  }
  return names;
}

export interface ToolListing {
  name: ToolName;
  label: string;
  description: string;
}

// Labels + descriptions live in `prompts.ts` so the LLM-facing tool
// description and the human-facing UI description stay in one place.
export async function listAvailableTools(): Promise<ToolListing[]> {
  const names = await listEnabledToolNames();
  return names.map((name) => ({
    name,
    label: TOOL_LABELS[name],
    description: TOOL_LABEL_DESCRIPTIONS[name],
  }));
}

/**
 * Names matching this regex bypass the chat-composer chip allow-list because
 * they have their own admin gate in Settings → Integrated MCP Tools (the
 * `enabledMcpTools` map already filtered them upstream in `getEnabledTools`).
 * The chip popover only knows about the 4 legacy tools; without this bypass,
 * its allow-list silently strips every MCP tool the user enabled in Settings.
 */
const MCP_TOOL_PREFIX = /^(comfy_|studio_|mcp__)/;

export function filterEnabledTools(
  enabled: EnabledToolMap,
  allow: readonly string[] | null,
): EnabledToolMap {
  if (!allow) return enabled;
  const allowSet = new Set(allow);
  const out: EnabledToolMap = {};
  for (const [name, def] of Object.entries(enabled)) {
    if (MCP_TOOL_PREFIX.test(name)) { out[name] = def; continue; }
    if (allowSet.has(name)) out[name] = def;
  }
  return out;
}
