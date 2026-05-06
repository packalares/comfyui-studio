// Unified registry for all 16 in-process MCP tools (10 comfy + 6 studio).
//
// Each tool exports a uniform shape: `description`, `inputShape` (zod), and
// `run(args)` returning a plain JS value (string or object). This file:
//   - registerAllTools(server)  — exposes them on Studio's MCP server
//   - getMcpToolsForChat()      — exposes them to Qwen's chat tool loop
// Both consumers share one source of truth: the TOOL_DEFS array below.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { defineTool, type StudioTool } from '../../chat/tools/defineTool.js';
import { logger } from '../../../lib/logger.js';

// --- comfy tools (raw async funcs from artokun port) -----------------------

import { getNodeInfo } from './tools/comfy/getNodeInfo.js';
import { searchModels } from './tools/comfy/searchModels.js';
import { searchCustomNodes } from './tools/comfy/searchCustomNodes.js';
import { getNodePackDetails } from './tools/comfy/getNodePackDetails.js';
import { getSystemStats } from './tools/comfy/getSystemStats.js';
import { clearVram } from './tools/comfy/clearVram.js';
import { workflowFromImage } from './tools/comfy/workflowFromImage.js';
import { analyzeWorkflow } from './tools/comfy/analyzeWorkflow.js';
import { validateWorkflow } from './tools/comfy/validateWorkflow.js';
import { visualizeWorkflow } from './tools/comfy/visualizeWorkflow.js';

// --- studio tools (uniform run/inputShape exports) -------------------------

import * as listTemplates from './tools/studio/listTemplates.js';
import * as describeTemplate from './tools/studio/describeTemplate.js';
import * as checkDependencies from './tools/studio/checkDependencies.js';
import * as submitGeneration from './tools/studio/submitGeneration.js';
import * as getJobStatus from './tools/studio/getJobStatus.js';
import * as listRecentOutputs from './tools/studio/listRecentOutputs.js';
import * as remember from './tools/studio/remember.js';
import * as proposeSoulEdit from './tools/studio/proposeSoulEdit.js';
import * as loadSkill from './tools/studio/loadSkill.js';
import * as listSkillsMcp from './tools/studio/listSkills.js';

// --- types -----------------------------------------------------------------

const workflowSchema = z.union([z.string(), z.record(z.string(), z.unknown())]);

interface ToolDef {
  /** MCP tool name (e.g. `studio.listTemplates`, `comfy.getNodeInfo`). */
  mcpName: string;
  /** Chat tool name (Ollama function-calling — `[A-Za-z0-9_]` only). */
  chatName: string;
  description: string;
  shape: Record<string, z.ZodType>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run: (args: any) => Promise<unknown>;
  unloadGpuOnUse?: boolean;
}

// --- adapters --------------------------------------------------------------

/** Comfy tools return `{ text, error? }`; flatten to text or surface error. */
async function runComfy(impl: (a: unknown) => Promise<{ text: string; error?: string }>, args: unknown): Promise<unknown> {
  const r = await impl(args);
  if (r.error) throw new Error(r.error);
  return r.text;
}

const comfyDefs: ToolDef[] = [
  {
    mcpName: 'comfy.getNodeInfo', chatName: 'comfy_get_node_info',
    description: 'Query ComfyUI /object_info for available node type definitions. Optional substring filter.',
    shape: { node_type: z.string().optional().describe('Substring filter on node name (case-insensitive)') },
    run: (a) => runComfy(getNodeInfo as (a: unknown) => Promise<{ text: string; error?: string }>, a),
  },
  {
    mcpName: 'comfy.searchModels', chatName: 'comfy_search_models',
    description: 'Search HuggingFace for models compatible with ComfyUI (checkpoints, LoRAs, VAEs, etc.).',
    shape: {
      query: z.string().describe('Search query'),
      filter: z.string().optional().describe('Tag filter (e.g. "diffusion-single-file")'),
      limit: z.number().int().min(1).max(50).optional(),
    },
    run: (a) => runComfy(searchModels as (a: unknown) => Promise<{ text: string; error?: string }>, a),
  },
  {
    mcpName: 'comfy.searchCustomNodes', chatName: 'comfy_search_custom_nodes',
    description: 'Search the ComfyUI Custom Nodes Registry for plugins by name or capability.',
    shape: {
      query: z.string().describe('Search query'),
      limit: z.number().int().min(1).max(50).optional(),
      page: z.number().int().min(1).optional(),
    },
    run: (a) => runComfy(searchCustomNodes as (a: unknown) => Promise<{ text: string; error?: string }>, a),
  },
  {
    mcpName: 'comfy.getNodePackDetails', chatName: 'comfy_get_node_pack_details',
    description: 'Fetch full details (versions, dependencies, repository) for a Custom Nodes Registry pack by id.',
    shape: { id: z.string().describe('Node pack id from search_custom_nodes') },
    run: (a) => runComfy(getNodePackDetails as (a: unknown) => Promise<{ text: string; error?: string }>, a),
  },
  {
    mcpName: 'comfy.getSystemStats', chatName: 'comfy_get_system_stats',
    description: 'Live ComfyUI system stats: VRAM, RAM, devices, model load state.',
    shape: {},
    run: () => runComfy(getSystemStats as () => Promise<{ text: string; error?: string }>, undefined),
  },
  {
    mcpName: 'comfy.clearVram', chatName: 'comfy_clear_vram',
    description: 'Ask ComfyUI to free GPU memory (unload models / free cache). Use when generation OOMs.',
    shape: {
      unload_models: z.boolean().optional(),
      free_memory: z.boolean().optional(),
    },
    run: (a) => runComfy(clearVram as (a: unknown) => Promise<{ text: string; error?: string }>, a),
  },
  {
    mcpName: 'comfy.workflowFromImage', chatName: 'comfy_workflow_from_image',
    description: 'Extract the embedded ComfyUI workflow JSON from a PNG file (reads tEXt/iTXt metadata).',
    shape: { image_path: z.string().describe('Absolute path to a PNG file with embedded workflow') },
    run: (a) => runComfy(workflowFromImage as (a: unknown) => Promise<{ text: string; error?: string }>, a),
  },
  {
    mcpName: 'comfy.analyzeWorkflow', chatName: 'comfy_analyze_workflow',
    description: 'Summarize or visualize a ComfyUI workflow JSON. View: "summary" (text) or "flat" (Mermaid diagram).',
    shape: {
      workflow: workflowSchema.describe('Workflow JSON object or string'),
      view: z.enum(['summary', 'flat']).optional(),
    },
    run: (a) => runComfy(analyzeWorkflow as (a: unknown) => Promise<{ text: string; error?: string }>, a),
  },
  {
    mcpName: 'comfy.validateWorkflow', chatName: 'comfy_validate_workflow',
    description: 'Validate a ComfyUI workflow against /object_info. Returns missing nodes, broken links, type mismatches.',
    shape: { workflow: workflowSchema.describe('Workflow JSON object or string') },
    run: (a) => runComfy(validateWorkflow as (a: unknown) => Promise<{ text: string; error?: string }>, a),
  },
  {
    mcpName: 'comfy.visualizeWorkflow', chatName: 'comfy_visualize_workflow',
    description: 'Render a ComfyUI workflow as a Mermaid graph for human inspection.',
    shape: {
      workflow: workflowSchema,
      show_values: z.boolean().optional(),
      direction: z.enum(['LR', 'TB']).optional(),
    },
    run: (a) => runComfy(visualizeWorkflow as (a: unknown) => Promise<{ text: string; error?: string }>, a),
  },
];

const studioDefs: ToolDef[] = [
  { mcpName: 'studio.listTemplates',     chatName: 'studio_list_templates',
    description: listTemplates.description,     shape: listTemplates.inputShape,
    run: listTemplates.run },
  { mcpName: 'studio.describeTemplate',  chatName: 'studio_describe_template',
    description: describeTemplate.description,  shape: describeTemplate.inputShape,
    run: describeTemplate.run },
  { mcpName: 'studio.checkDependencies', chatName: 'studio_check_dependencies',
    description: checkDependencies.description, shape: checkDependencies.inputShape,
    run: checkDependencies.run },
  { mcpName: 'studio.submitGeneration',  chatName: 'studio_submit_generation',
    description: submitGeneration.description,  shape: submitGeneration.inputShape,
    run: submitGeneration.run },
  { mcpName: 'studio.getJobStatus',      chatName: 'studio_get_job_status',
    description: getJobStatus.description,      shape: getJobStatus.inputShape,
    run: getJobStatus.run },
  { mcpName: 'studio.listRecentOutputs', chatName: 'studio_list_recent_outputs',
    description: listRecentOutputs.description, shape: listRecentOutputs.inputShape,
    run: listRecentOutputs.run },
  { mcpName: 'studio.remember', chatName: 'studio_remember',
    description: remember.description, shape: remember.inputShape,
    run: remember.run },
  { mcpName: 'studio.proposeSoulEdit', chatName: 'studio_propose_soul_edit',
    description: proposeSoulEdit.description, shape: proposeSoulEdit.inputShape,
    run: proposeSoulEdit.run },
  { mcpName: 'studio.loadSkill', chatName: 'studio_load_skill',
    description: loadSkill.description, shape: loadSkill.inputShape,
    run: loadSkill.run },
  { mcpName: 'studio.listSkills', chatName: 'studio_list_skills',
    description: listSkillsMcp.description, shape: listSkillsMcp.inputShape,
    run: listSkillsMcp.run },
];

const TOOL_DEFS: ToolDef[] = [...comfyDefs, ...studioDefs];

// --- public API ------------------------------------------------------------

/** Register all 16 tools on the given MCP server. */
export function registerAllTools(server: McpServer): void {
  for (const def of TOOL_DEFS) {
    server.tool(def.mcpName, def.description, def.shape, async (args: unknown) => {
      try {
        const result = await def.run(args);
        const text = typeof result === 'string' ? result : JSON.stringify(result);
        return { content: [{ type: 'text' as const, text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }],
          isError: true,
        };
      }
    });
  }
  logger.info(`MCP: registered ${TOOL_DEFS.length} tools (10 comfy + 10 studio)`);
}

/** Public listing for the chat composer's tool-toggle popover. */
export interface McpToolListing {
  name: string;        // chat tool name (the same key used in getMcpToolsForChat)
  label: string;       // human-readable
  description: string;
  category: 'comfy' | 'studio';
}

function humanizeName(chatName: string): string {
  // 'comfy_get_node_info' → 'Get node info'
  const parts = chatName.split('_').slice(1);
  if (parts.length === 0) return chatName;
  parts[0] = parts[0]!.charAt(0).toUpperCase() + parts[0]!.slice(1);
  return parts.join(' ');
}

export function getMcpToolListings(): McpToolListing[] {
  return TOOL_DEFS.map((def) => ({
    name: def.chatName,
    label: humanizeName(def.chatName),
    description: def.description,
    category: def.chatName.startsWith('comfy_') ? 'comfy' : 'studio',
  }));
}

/** Wrap all 16 tools as StudioTool entries for the Ollama chat tool loop. */
export function getMcpToolsForChat(): Record<string, StudioTool> {
  const out: Record<string, StudioTool> = {};
  for (const def of TOOL_DEFS) {
    out[def.chatName] = defineTool({
      description: def.description,
      inputSchema: z.object(def.shape),
      execute: async (args: unknown) => {
        try {
          const result = await def.run(args);
          return typeof result === 'string' ? result : JSON.stringify(result);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(`chat tool ${def.chatName} failed`, { error: msg });
          return `Error: ${msg}`;
        }
      },
      unloadGpuOnUse: def.unloadGpuOnUse ?? false,
    });
  }
  return out;
}
