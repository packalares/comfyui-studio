/**
 * API routes + workflow conversion.
 *
 * Known quirk — LoadImage / LoadAudio / LoadVideo extra `upload` input:
 *   When we inject user-uploaded files into the API prompt (see formInputs loop in
 *   workflowToApiPrompt) we set BOTH `inputs.image = "file.png"` AND
 *   `inputs.upload = "image"`. The `upload` key is NOT part of LoadImage's
 *   schema — it's a widget hint from the UI workflow (`widgets_values[1]`
 *   carries it in LiteGraph format). ComfyUI's own "Save (API)" exporter drops
 *   it, and its `/api/prompt` validator silently ignores unknown keys, so
 *   including it is harmless but non-canonical. We keep it because it mirrors
 *   the UI-format payload that some downstream tooling / logs might expect.
 *   Strip it only if you need byte-identical output to the official exporter.
 */

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import * as comfyui from '../services/comfyui.js';
import * as templates from '../services/templates.js';
import * as settings from '../services/settings.js';
import * as catalog from '../services/catalog.js';
import { trackDownload, stopTracking, getAllDownloads, findByIdentity, isAtCapacity, enqueueDownload, findQueuedByIdentity } from '../services/downloads.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 256 * 1024 * 1024 } });

const router = Router();

const LAUNCHER_URL = process.env.LAUNCHER_URL || 'http://localhost:3000';
const COMFYUI_URL = process.env.COMFYUI_URL || 'http://localhost:8188';

// ---- Helper to proxy requests to launcher ----
async function proxyToLauncher(
  path: string,
  method: string = 'GET',
  body?: unknown
): Promise<unknown> {
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${LAUNCHER_URL}${path}`, opts);
  if (!res.ok) {
    throw new Error(`Launcher API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// Health check
router.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ---- Comfy Org API key (stored server-side, never returned to client) ----
router.get('/settings/api-key', (_req: Request, res: Response) => {
  res.json({ configured: settings.isApiKeyConfigured() });
});

router.put('/settings/api-key', (req: Request, res: Response) => {
  const { apiKey } = req.body as { apiKey?: unknown };
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    res.status(400).json({ error: 'apiKey must be a non-empty string' });
    return;
  }
  settings.setApiKey(apiKey.trim());
  res.json({ configured: true });
});

router.delete('/settings/api-key', (_req: Request, res: Response) => {
  settings.clearApiKey();
  res.json({ configured: false });
});

// ---- HuggingFace token (for gated models + private HEAD/GET requests) ----
router.get('/settings/hf-token', (_req: Request, res: Response) => {
  res.json({ configured: settings.isHfTokenConfigured() });
});

router.put('/settings/hf-token', (req: Request, res: Response) => {
  const { token } = req.body as { token?: unknown };
  if (typeof token !== 'string' || token.trim().length === 0) {
    res.status(400).json({ error: 'token must be a non-empty string' });
    return;
  }
  settings.setHfToken(token.trim());
  res.json({ configured: true });
});

router.delete('/settings/hf-token', (_req: Request, res: Response) => {
  settings.clearHfToken();
  res.json({ configured: false });
});

// ---- Model catalog (merged view; seed from ComfyUI on first read, then joined with disk scan) ----
router.get('/models/catalog', async (_req: Request, res: Response) => {
  res.json(await catalog.getMergedModels());
});

// Force-refresh size info for a specific model (or all stale ones). Used when the user
// clicks Download so the size is fresh before the progress bar appears.
router.post('/models/catalog/refresh-size', async (req: Request, res: Response) => {
  const { filename, filenames } = (req.body || {}) as { filename?: string; filenames?: string[] };
  await catalog.seedFromComfyUI();
  if (filename) {
    const m = await catalog.refreshSize(filename, { force: true });
    res.json(m);
    return;
  }
  if (Array.isArray(filenames)) {
    await catalog.refreshMany(filenames, { force: true, concurrency: 8 });
    res.json({ ok: true });
    return;
  }
  res.status(400).json({ error: 'provide `filename` or `filenames`' });
});

// Combined system info: device stats + queue + recent gallery.
// Each source is fetched independently — a partial failure still returns what's available.
router.get('/system', async (_req: Request, res: Response) => {
  const [statsResult, queueResult, galleryResult] = await Promise.allSettled([
    comfyui.getSystemStats(),
    comfyui.getQueue(),
    comfyui.getGalleryItems(),
  ]);

  const stats = statsResult.status === 'fulfilled' ? statsResult.value : null;
  const queue = queueResult.status === 'fulfilled' ? queueResult.value : null;
  const gallery = galleryResult.status === 'fulfilled' ? galleryResult.value : [];

  if (!stats && !queue) {
    res.status(502).json({ error: 'Cannot reach ComfyUI' });
    return;
  }

  res.json({
    ...(stats as object || {}),
    queue,
    gallery: {
      total: gallery.length,
      recent: gallery.slice(0, 8),
    },
  });
});

// Templates — always fetch fresh from ComfyUI.
// When no Comfy Org API key is configured, hide API-node workflows entirely
// so they don't appear anywhere in the UI (Explore, Studio, model-dep filters).
router.get('/templates', async (_req: Request, res: Response) => {
  try {
    await templates.loadTemplatesFromComfyUI(COMFYUI_URL);
  } catch {
    // will return cached or empty
  }
  const all = templates.getTemplates();
  const result = settings.isApiKeyConfigured()
    ? all
    : all.filter(t => t.openSource !== false);
  res.json(result);
});

router.get('/templates/:name', (req: Request, res: Response) => {
  const t = templates.getTemplate(req.params.name as string);
  if (!t) {
    res.status(404).json({ error: 'Template not found' });
    return;
  }
  res.json(t);
});

// Proxy template assets (thumbnails, input/output images) from ComfyUI
router.get('/template-asset/*', async (req: Request, res: Response) => {
  try {
    const assetPath = req.params[0];
    const url = `${COMFYUI_URL}/templates/${assetPath}`;
    const response = await fetch(url);
    if (!response.ok) {
      res.status(response.status).end();
      return;
    }
    const contentType = response.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    const buffer = Buffer.from(await response.arrayBuffer());
    res.send(buffer);
  } catch {
    res.status(502).end();
  }
});

// ---- Advanced workflow settings extraction ----

// Widget names to hide from advanced settings
const HIDDEN_WIDGET_NAMES = new Set([
  'text', 'prompt', 'control_after_generate',
]);

// Patterns in widget names that indicate model files (hide these)
const MODEL_NAME_PATTERNS = ['model', 'unet', 'clip', 'vae', 'lora', 'checkpoint', 'ckpt'];

function isHiddenWidget(widgetName: string): boolean {
  if (HIDDEN_WIDGET_NAMES.has(widgetName)) return true;
  // Hide *_name widgets that are model filenames
  const lower = widgetName.toLowerCase();
  if (lower.endsWith('_name') && MODEL_NAME_PATTERNS.some(p => lower.includes(p))) return true;
  // Hide any widget whose name directly matches a model pattern
  if (MODEL_NAME_PATTERNS.some(p => lower === p)) return true;
  return false;
}

interface AdvancedSetting {
  id: string;
  label: string;
  type: 'number' | 'slider' | 'seed' | 'select' | 'toggle';
  value: unknown;
  min?: number;
  max?: number;
  step?: number;
  options?: { label: string; value: string }[];
  proxyIndex: number;
}

// Widget names that carry no semantic info by themselves — common generic slot names
// on wrapper nodes. When we hit one, prefer the source node title for the label.
const BLAND_WIDGET_NAMES = new Set(['value', 'enabled', 'on', 'off', 'bool', 'active', 'input']);

function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Known setting defaults for common widget names
const KNOWN_SETTINGS: Record<string, Partial<AdvancedSetting>> = {
  width:    { type: 'number', min: 64, max: 4096, step: 64 },
  height:   { type: 'number', min: 64, max: 4096, step: 64 },
  steps:    { type: 'slider', min: 1, max: 100, step: 1 },
  seed:     { type: 'seed' },
  noise_seed: { type: 'seed' },
  length:   { type: 'slider', min: 1, max: 300, step: 1 },
  cfg:      { type: 'slider', min: 1, max: 30, step: 0.5 },
  denoise:  { type: 'slider', min: 0, max: 1, step: 0.05 },
  shift:    { type: 'slider', min: 0, max: 100, step: 0.1 },
};

/**
 * Resolve a human-readable label for each proxyWidget entry.
 *
 * ComfyUI templates expose widgets through wrapper nodes; the raw entry is
 * `[innerNodeId, widgetName]` where the widget name is often generic ("value",
 * "enabled") and the id alone is meaningless to users. To do better:
 *
 *   1. When innerNodeId is "-1" (subgraph-self), follow the subgraph link with
 *      `origin_id === -10` whose slot matches this widget to find the actual
 *      target node and input inside the subgraph.
 *   2. If the subgraph input has a custom `label` or `localized_name`, prefer it.
 *   3. Use the resolved target node's title + target input name; collapse to
 *      just the node title when the input name is itself generic.
 */
function resolveProxyLabels(
  wrapperNode: Record<string, unknown>,
  proxyWidgets: string[][],
  workflow: Record<string, unknown>,
): string[] {
  // The inner subgraph definition lives either inline on the node or in
  // `workflow.definitions.subgraphs`. In the stored template format that map
  // is an ARRAY of { id, nodes, links, inputs, ... } whose `id` matches the
  // wrapper node's `type`. Support both array and object shapes for safety.
  const inlineSg = wrapperNode.subgraph as Record<string, unknown> | undefined;
  const rawSgs = (workflow.definitions as Record<string, unknown> | undefined)?.subgraphs;
  const wrapperType = wrapperNode.type as string;
  let sg: Record<string, unknown> | null = inlineSg ?? null;
  if (!sg && Array.isArray(rawSgs)) {
    sg = (rawSgs as Array<Record<string, unknown>>).find(s => s.id === wrapperType) ?? null;
  } else if (!sg && rawSgs && typeof rawSgs === 'object') {
    sg = (rawSgs as Record<string, Record<string, unknown>>)[wrapperType] ?? null;
  }

  const sgNodes = (sg?.nodes || []) as Array<Record<string, unknown>>;
  const sgLinks = (sg?.links || []) as Array<Record<string, unknown>>;
  const sgInputs = (sg?.inputs || []) as Array<Record<string, unknown>>;

  // Map subgraph input slot → the internal (targetNodeId, inputName) it connects to.
  const slotTargets = new Map<number, { nodeId: number; inputName: string }>();
  for (const link of sgLinks) {
    const l = link as Record<string, unknown>;
    if (l.origin_id !== -10) continue;
    const slot = l.origin_slot as number;
    const targetId = l.target_id as number;
    const targetNode = sgNodes.find(n => (n.id as number) === targetId);
    const targetInputs = (targetNode?.inputs || []) as Array<Record<string, unknown>>;
    const targetInput = targetInputs.find(inp => (inp as Record<string, unknown>).link === l.id);
    const inputName = ((targetInput?.widget as Record<string, unknown> | undefined)?.name as string)
      || (targetInput?.name as string) || '';
    slotTargets.set(slot, { nodeId: targetId, inputName });
  }

  return proxyWidgets.map(([innerNodeId, widgetName], i) => {
    let targetNode: Record<string, unknown> | undefined;
    let displayWidget = widgetName;

    if (innerNodeId === '-1') {
      // Prefer an explicit label on the subgraph input
      const sgInput = sgInputs.find(inp => (inp as Record<string, unknown>).name === widgetName);
      const explicit = (sgInput as Record<string, unknown> | undefined)?.label as string | undefined
        ?? (sgInput as Record<string, unknown> | undefined)?.localized_name as string | undefined;
      if (explicit && explicit !== widgetName) return titleCase(explicit);

      // Follow the -10 wire to find the real target
      const sgIdx = sgInputs.findIndex(inp => (inp as Record<string, unknown>).name === widgetName);
      const target = slotTargets.get(sgIdx >= 0 ? sgIdx : i);
      if (target) {
        targetNode = sgNodes.find(n => (n.id as number) === target.nodeId);
        if (target.inputName) displayWidget = target.inputName;
      }
    } else {
      targetNode = sgNodes.find(n => String(n.id) === innerNodeId);
    }

    const title = ((targetNode?.title as string) || (targetNode?.type as string) || '').trim();
    if (BLAND_WIDGET_NAMES.has(displayWidget.toLowerCase())) {
      return title || titleCase(displayWidget);
    }
    const widgetLabel = titleCase(displayWidget);
    return title ? `${title} · ${widgetLabel}` : widgetLabel;
  });
}

function extractAdvancedSettings(
  proxyWidgets: string[][],
  widgetValues: unknown[],
  objectInfo: Record<string, Record<string, unknown>>,
  labels: string[],
): AdvancedSetting[] {
  const settings: AdvancedSetting[] = [];

  for (let i = 0; i < proxyWidgets.length; i++) {
    const [, widgetName] = proxyWidgets[i];
    if (isHiddenWidget(widgetName)) continue;
    const label = labels[i] ?? titleCase(widgetName);

    const value = i < widgetValues.length ? widgetValues[i] : null;
    const known = KNOWN_SETTINGS[widgetName];

    if (known) {
      settings.push({
        id: widgetName,
        label,
        type: known.type ?? 'number',
        value,
        min: known.min,
        max: known.max,
        step: known.step,
        proxyIndex: i,
      });
      continue;
    }

    // Try to infer type from the value
    if (typeof value === 'boolean') {
      settings.push({
        id: widgetName,
        label,
        type: 'toggle',
        value,
        proxyIndex: i,
      });
      continue;
    }

    // Check if it looks like a COMBO widget (string value that's not a filename)
    if (typeof value === 'string' && value.length > 0) {
      // Skip values that look like file paths
      if (value.includes('/') || value.includes('\\') ||
          value.endsWith('.safetensors') || value.endsWith('.pth') ||
          value.endsWith('.ckpt') || value.endsWith('.bin')) {
        continue;
      }

      // Try to find option lists from object_info for known combo widgets
      const comboWidgets = ['sampler_name', 'scheduler', 'aspect_ratio'];
      if (comboWidgets.includes(widgetName)) {
        // Look through object_info for nodes that have this widget
        const options: string[] = [];
        for (const [, nodeInfo] of Object.entries(objectInfo)) {
          const info = nodeInfo as { input?: { required?: Record<string, unknown[]>; optional?: Record<string, unknown[]> } };
          const allInputs = { ...(info?.input?.required || {}), ...(info?.input?.optional || {}) };
          const spec = allInputs[widgetName];
          if (spec && Array.isArray(spec) && Array.isArray(spec[0])) {
            for (const opt of spec[0]) {
              if (typeof opt === 'string' && !options.includes(opt)) {
                options.push(opt);
              }
            }
            if (options.length > 0) break;
          }
        }

        if (options.length > 0) {
          settings.push({
            id: widgetName,
            label,
            type: 'select',
            value,
            options: options.map(o => ({ label: o, value: o })),
            proxyIndex: i,
          });
          continue;
        }
      }

      // Generic string combo — skip unless we find options
      continue;
    }

    // Numeric value — expose as slider or number
    if (typeof value === 'number') {
      settings.push({
        id: widgetName,
        label,
        type: 'slider',
        value,
        min: 0,
        max: Math.max(value * 4, 100),
        step: Number.isInteger(value) ? 1 : 0.1,
        proxyIndex: i,
      });
    }
  }

  return settings;
}

router.get('/workflow-settings/:templateName', async (req: Request, res: Response) => {
  try {
    const templateName = req.params.templateName as string;

    // 1. Fetch the workflow JSON
    const wfRes = await fetch(`${COMFYUI_URL}/templates/${encodeURIComponent(templateName)}.json`);
    if (!wfRes.ok) {
      res.status(404).json({ error: 'Workflow not found' });
      return;
    }
    const workflow = await wfRes.json();

    // 2. Find the wrapper node (the one with proxyWidgets)
    const topNodes = (workflow.nodes || []) as Array<Record<string, unknown>>;
    let wrapperNode: Record<string, unknown> | null = null;
    let proxyWidgets: string[][] | null = null;
    let widgetValues: unknown[] = [];

    for (const node of topNodes) {
      const props = node.properties as Record<string, unknown> | undefined;
      if (props?.proxyWidgets && Array.isArray(props.proxyWidgets)) {
        wrapperNode = node;
        proxyWidgets = props.proxyWidgets as string[][];
        widgetValues = (node.widgets_values || []) as unknown[];
        break;
      }
    }

    if (!wrapperNode || !proxyWidgets || proxyWidgets.length === 0) {
      res.json({ settings: [] });
      return;
    }

    // 3. Resolve friendly labels by following subgraph wires to real target nodes.
    const labels = resolveProxyLabels(wrapperNode, proxyWidgets, workflow);

    // 4. Extract settings
    const objectInfo = await getObjectInfo();
    const settings = extractAdvancedSettings(proxyWidgets, widgetValues, objectInfo, labels);

    res.json({ settings });
  } catch (err) {
    res.status(500).json({ error: 'Failed to extract workflow settings', detail: String(err) });
  }
});

// Generate (submit workflow to ComfyUI)
// Cache object_info from ComfyUI
let cachedObjectInfo: Record<string, Record<string, unknown>> | null = null;

async function getObjectInfo(): Promise<Record<string, Record<string, unknown>>> {
  if (!cachedObjectInfo) {
    try {
      const res = await fetch(`${COMFYUI_URL}/api/object_info`);
      if (res.ok) cachedObjectInfo = await res.json();
    } catch { /* ignore */ }
  }
  return cachedObjectInfo || {};
}

// Primitive widget types always treated as widget values.
const WIDGET_PRIMITIVES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO']);

// Get API widget names for a node type (excludes connection-type inputs).
// Rule: connections are ALL_CAPS identifiers other than the primitives
// (MODEL, IMAGE, CLIP, VAE, CONDITIONING, LATENT, …). Anything else — lowercase
// custom types, option arrays, compound names — counts as a widget. This avoids
// mis-filtering custom lowercase widget types (which would desync widget_values).
function getApiWidgetNames(objectInfo: Record<string, Record<string, unknown>>, classType: string): string[] {
  const info = objectInfo[classType] as { input?: { required?: Record<string, unknown[]>; optional?: Record<string, unknown[]> } } | undefined;
  if (!info?.input) return [];
  const names: string[] = [];
  for (const [name, spec] of Object.entries(info.input.required || {})) {
    if (!Array.isArray(spec) || spec.length === 0) continue;
    const type = spec[0];
    if (Array.isArray(type)) { names.push(name); continue; } // legacy COMBO options array
    if (typeof type === 'string') {
      const isUpperConnection = type === type.toUpperCase() && !WIDGET_PRIMITIVES.has(type);
      if (isUpperConnection) continue;
    }
    names.push(name);
  }
  return names;
}

// Frontend-only widget values that appear in widgets_values but not in API
const FRONTEND_ONLY_VALUES = new Set(['randomize', 'fixed', 'increment', 'decrement']);

// Normalized link shape used by the flattener. Uses string node IDs so nested
// subgraph instances (which share local numeric IDs) don't collide.
interface FlatLink {
  id: number;
  origin_id: string;
  origin_slot: number;
  target_id: string;
  target_slot: number;
}

interface FlatNodeInput {
  name: string;
  /** Points at a FlatLink.id (global, freshly-assigned during flattening). */
  link?: number | null;
  widget?: { name: string };
}

interface FlatNode {
  id: string;
  type: string;
  inputs: FlatNodeInput[];
  widgets_values: unknown[];
  /** User-facing title shown in the LiteGraph UI; forwarded to API prompt as `_meta.title`. */
  title?: string;
  /** LiteGraph node.mode: 0 = normal, 2 = muted, 4 = bypassed. */
  mode?: number;
  /** Per-widget overrides applied by proxyWidgets on a parent wrapper. */
  overrides?: Record<string, unknown>;
}

// Raw LiteGraph link (before global-ID rewriting).
interface RawLink {
  id: number;
  origin_id: number;
  origin_slot: number;
  target_id: number;
  target_slot: number;
}

// LiteGraph stores links in two shapes: arrays `[id, origin_id, origin_slot, target_id, target_slot, type]`
// at the top level, and objects inside subgraph definitions. Normalize to objects.
function normalizeLinks(raw: unknown[]): RawLink[] {
  const out: RawLink[] = [];
  for (const l of raw) {
    if (Array.isArray(l)) {
      out.push({
        id: l[0] as number,
        origin_id: l[1] as number,
        origin_slot: l[2] as number,
        target_id: l[3] as number,
        target_slot: l[4] as number,
      });
    } else if (l && typeof l === 'object') {
      const ll = l as Record<string, unknown>;
      out.push({
        id: ll.id as number,
        origin_id: ll.origin_id as number,
        origin_slot: ll.origin_slot as number,
        target_id: ll.target_id as number,
        target_slot: ll.target_slot as number,
      });
    }
  }
  return out;
}

/**
 * Recursively flatten a LiteGraph workflow with nested subgraphs into a single
 * list of nodes + links with global IDs. Wrapper nodes are replaced by their
 * inner nodes; external input/output pins (origin_id=-10, target_id=-20) are
 * rewired to the wrapper's outer neighbors so every link in the returned list
 * references real nodes.
 */
function flattenWorkflow(wf: Record<string, unknown>): { nodes: Map<string, FlatNode>; links: FlatLink[] } {
  const subgraphDefs = ((wf.definitions as Record<string, unknown> | undefined)?.subgraphs || []) as Array<Record<string, unknown>>;
  const sgMap = new Map<string, Record<string, unknown>>();
  for (const sg of subgraphDefs) sgMap.set(sg.id as string, sg);

  const nodes = new Map<string, FlatNode>();
  const links: FlatLink[] = [];
  let nextLinkId = 1;

  // wrapperOutputs: <wrapper's global id> → <output pin idx → (real global nodeId, slot)>.
  // Populated while expanding each wrapper instance; read by the outer scope when emitting
  // links whose origin is that wrapper.
  const wrapperOutputs = new Map<string, Map<number, { nodeId: string; slot: number }>>();

  /**
   * Expand a scope into the global flat graph.
   *
   * prefix: the path prefix (empty at top) used to build unique global node IDs.
   * scopeNodes/scopeLinks: the nodes and (local) links of this scope.
   * inputSubs: maps this scope's external input pin index → real upstream (global nodeId, slot).
   * outputSubs: maps this scope's external output pin index → list of real downstream (global nodeId, slot).
   * proxyOverrides: maps global inner-node ID → { inputName: value } overrides from the wrapper above.
   */
  function expandScope(
    prefix: string,
    scopeNodes: Array<Record<string, unknown>>,
    scopeLinks: RawLink[],
    inputSubs: Map<number, { nodeId: string; slot: number }>,
    outputSubs: Map<number, Array<{ nodeId: number; slot: number }> | Array<{ nodeId: string; slot: number }>>,
    proxyOverrides: Map<string, Record<string, unknown>>,
  ): void {
    const toGlobal = (localId: number): string => prefix ? `${prefix}:${localId}` : String(localId);

    // Fresh link-id map for this scope so the same local link appears only once in the global list
    // and inner-node input references can use the global id.
    const linkIdMap = new Map<number, number>();
    for (const l of scopeLinks) linkIdMap.set(l.id, nextLinkId++);

    // 1) Recursively expand wrapper nodes FIRST. This populates wrapperOutputs so the
    //    subsequent link-emission pass can resolve wrapper-origin references.
    for (const node of scopeNodes) {
      const type = node.type as string;
      if (!type || type === 'MarkdownNote' || type === 'Note') continue;
      const localId = node.id as number;
      if (localId < 0) continue;
      const sg = sgMap.get(type);
      if (!sg) continue;
      expandWrapper(node, sg, prefix, scopeNodes, scopeLinks, inputSubs, outputSubs, toGlobal(localId));
    }

    // 2) Emit links with rewritten endpoints (handles -10 input, -20 output, wrapper origins).
    for (const link of scopeLinks) {
      const gid = linkIdMap.get(link.id)!;
      let origin = resolveOrigin(link.origin_id, link.origin_slot, toGlobal, inputSubs, scopeNodes);
      if (!origin) continue;

      if (link.target_id === -20) {
        // Feed each outer consumer of the corresponding external output pin.
        const subs = outputSubs.get(link.target_slot) || [];
        for (const sub of subs) {
          links.push({
            id: nextLinkId++,
            origin_id: origin.nodeId,
            origin_slot: origin.slot,
            target_id: String(sub.nodeId),
            target_slot: sub.slot,
          });
        }
        continue;
      }

      // If target is a wrapper, the link is consumed by the wrapper's own expansion
      // (via innerInputSubs of that wrapper) — we drop it at this layer to avoid a dangling edge.
      const targetNode = scopeNodes.find(n => (n.id as number) === link.target_id);
      if (targetNode && sgMap.has(targetNode.type as string)) continue;

      links.push({
        id: gid,
        origin_id: origin.nodeId,
        origin_slot: origin.slot,
        target_id: toGlobal(link.target_id),
        target_slot: link.target_slot,
      });
    }

    // 3) Emit real nodes (skip wrappers — already expanded above).
    for (const node of scopeNodes) {
      const type = node.type as string;
      if (!type || type === 'MarkdownNote' || type === 'Note') continue;
      const localId = node.id as number;
      if (localId < 0) continue;
      if (sgMap.has(type)) continue;
      // LiteGraph mode 2 = muted. Drop entirely so nothing depends on it.
      // (Bypass/mode 4 is preserved and handled at prompt-build time via resolveLinkOrigin.)
      if ((node.mode as number | undefined) === 2) continue;

      const gid = toGlobal(localId);
      // Rewrite this node's input link references from local → global ids.
      const rawInputs = (node.inputs || []) as FlatNodeInput[];
      const inputs: FlatNodeInput[] = rawInputs.map(inp => {
        if (inp.link == null) return inp;
        const mapped = linkIdMap.get(inp.link);
        return mapped != null ? { ...inp, link: mapped } : { ...inp, link: null };
      });

      nodes.set(gid, {
        id: gid,
        type,
        inputs,
        widgets_values: (node.widgets_values || []) as unknown[],
        title: node.title as string | undefined,
        mode: node.mode as number | undefined,
        overrides: proxyOverrides.get(gid),
      });
    }
  }

  function resolveOrigin(
    originId: number,
    originSlot: number,
    toGlobal: (id: number) => string,
    inputSubs: Map<number, { nodeId: string; slot: number }>,
    scopeNodes: Array<Record<string, unknown>>,
  ): { nodeId: string; slot: number } | null {
    if (originId === -10) {
      return inputSubs.get(originSlot) || null;
    }
    const node = scopeNodes.find(n => (n.id as number) === originId);
    if (!node) return { nodeId: toGlobal(originId), slot: originSlot };
    const sg = sgMap.get(node.type as string);
    if (!sg) return { nodeId: toGlobal(originId), slot: originSlot };
    // Wrapper — look up its real output source by this wrapper's GLOBAL id.
    return wrapperOutputs.get(toGlobal(originId))?.get(originSlot) || null;
  }

  function expandWrapper(
    wrapper: Record<string, unknown>,
    sg: Record<string, unknown>,
    outerPrefix: string,
    outerNodes: Array<Record<string, unknown>>,
    outerLinks: RawLink[],
    outerInputSubs: Map<number, { nodeId: string; slot: number }>,
    outerOutputSubs: Map<number, Array<{ nodeId: number; slot: number }> | Array<{ nodeId: string; slot: number }>>,
    wrapperGlobalId: string,
  ): void {
    const outerToGlobal = (id: number): string => outerPrefix ? `${outerPrefix}:${id}` : String(id);

    // Build this wrapper's inputSubs: for each wrapper input pin, resolve the real outer source.
    // Key by the subgraph-definition input INDEX (matched by name), not the outer position —
    // ComfyUI can reorder a wrapper's outer pins independently of the sg definition.
    const sgInputDefsEarly = (sg.inputs || []) as Array<Record<string, unknown>>;
    const innerInputSubs = new Map<number, { nodeId: string; slot: number }>();
    const wrapperInputs = (wrapper.inputs || []) as Array<Record<string, unknown>>;
    for (let i = 0; i < wrapperInputs.length; i++) {
      const outerInput = wrapperInputs[i];
      const linkId = outerInput.link as number | null | undefined;
      if (linkId == null) continue;
      const link = outerLinks.find(l => l.id === linkId);
      if (!link) continue;
      const outerName = outerInput.name as string | undefined;
      const sgIdx = outerName != null
        ? sgInputDefsEarly.findIndex(sgInp => (sgInp.name as string) === outerName)
        : -1;
      const key = sgIdx >= 0 ? sgIdx : i; // fall back to position if no name match
      const origin = resolveOrigin(link.origin_id, link.origin_slot, outerToGlobal, outerInputSubs, outerNodes);
      if (origin) innerInputSubs.set(key, origin);
    }

    // Build this wrapper's outputSubs: for each output pin, resolve outer consumers.
    const innerOutputSubs = new Map<number, Array<{ nodeId: string; slot: number }>>();
    const wrapperOuts = (wrapper.outputs || []) as Array<{ links?: number[] }>;
    for (let i = 0; i < wrapperOuts.length; i++) {
      const outLinkIds = wrapperOuts[i].links || [];
      const targets: Array<{ nodeId: string; slot: number }> = [];
      for (const tlId of outLinkIds) {
        const tl = outerLinks.find(l => l.id === tlId);
        if (!tl) continue;
        if (tl.target_id === -20) {
          const parents = outerOutputSubs.get(tl.target_slot) || [];
          for (const p of parents) {
            targets.push({ nodeId: typeof p.nodeId === 'string' ? p.nodeId : String(p.nodeId), slot: p.slot });
          }
        } else {
          targets.push({ nodeId: outerToGlobal(tl.target_id), slot: tl.target_slot });
        }
      }
      innerOutputSubs.set(i, targets);
    }

    // Build proxyWidget overrides for this wrapper's inner nodes (with GLOBAL ids).
    const proxyWidgets = ((wrapper.properties as Record<string, unknown> | undefined)?.proxyWidgets || []) as string[][];
    const wrapperWidgetVals = (wrapper.widgets_values || []) as unknown[];
    const sgNodes = (sg.nodes || []) as Array<Record<string, unknown>>;
    const sgLinks = normalizeLinks((sg.links || []) as unknown[]);
    const sgInputDefs = (sg.inputs || []) as Array<Record<string, unknown>>;

    const slotToTarget = new Map<number, { nodeId: number; inputName: string }>();
    for (const l of sgLinks) {
      if (l.origin_id !== -10) continue;
      const targetNode = sgNodes.find(n => (n.id as number) === l.target_id);
      const tInputs = (targetNode?.inputs || []) as Array<Record<string, unknown>>;
      const tInput = tInputs.find(inp => (inp as Record<string, unknown>).link === l.id);
      const inputName = ((tInput?.widget as Record<string, unknown> | undefined)?.name as string)
        || (tInput?.name as string) || '';
      slotToTarget.set(l.origin_slot, { nodeId: l.target_id, inputName });
    }

    const innerPrefix = wrapperGlobalId;
    const innerToGlobal = (id: number): string => `${innerPrefix}:${id}`;
    const overrides = new Map<string, Record<string, unknown>>();
    for (let i = 0; i < proxyWidgets.length && i < wrapperWidgetVals.length; i++) {
      const [innerNodeIdStr, widgetName] = proxyWidgets[i];
      const val = wrapperWidgetVals[i];
      if (val === null) continue;
      let targetLocalId: number;
      let targetName: string;
      if (innerNodeIdStr === '-1') {
        const sgIdx = sgInputDefs.findIndex(inp => (inp as Record<string, unknown>).name === widgetName);
        const target = slotToTarget.get(sgIdx >= 0 ? sgIdx : i);
        if (!target) continue;
        targetLocalId = target.nodeId;
        targetName = target.inputName;
      } else {
        targetLocalId = Number(innerNodeIdStr);
        targetName = widgetName;
      }
      const gid = innerToGlobal(targetLocalId);
      if (!overrides.has(gid)) overrides.set(gid, {});
      overrides.get(gid)![targetName] = val;
    }

    // Recurse into the subgraph with the fresh prefix.
    expandScope(innerPrefix, sgNodes, sgLinks, innerInputSubs, innerOutputSubs, overrides);

    // After recursion, record where each output pin of THIS wrapper really sources from,
    // so the outer scope's link emission can rewrite origin_id from the wrapper to that real node.
    const myOutputs = new Map<number, { nodeId: string; slot: number }>();
    const sgOutputs = (sg.outputs || []) as Array<Record<string, unknown>>;
    for (let i = 0; i < sgOutputs.length; i++) {
      const linkIds = (sgOutputs[i].linkIds || []) as number[];
      if (linkIds.length === 0) continue;
      const link = sgLinks.find(l => l.id === linkIds[0]);
      if (!link) continue;
      const origin = resolveOrigin(link.origin_id, link.origin_slot, innerToGlobal, innerInputSubs, sgNodes);
      if (origin) myOutputs.set(i, origin);
    }
    wrapperOutputs.set(wrapperGlobalId, myOutputs);
  }

  expandScope(
    '',
    (wf.nodes || []) as Array<Record<string, unknown>>,
    normalizeLinks((wf.links || []) as unknown[]),
    new Map(),
    new Map(),
    new Map(),
  );

  return { nodes, links };
}

type InputResolution =
  | { kind: 'ref'; nodeId: string; slot: number }
  | { kind: 'literal'; value: unknown };

interface ResolveCtx {
  linkMap: Map<number, FlatLink>;
  nodes: Map<string, FlatNode>;
  objectInfo: Record<string, Record<string, unknown>>;
  /** Maps a SetNode variable name → resolved value source (pre-computed). */
  setterMap: Map<string, InputResolution>;
}

/**
 * Follow a link through any non-executable / pass-through node to find either a literal
 * value or the real upstream `(nodeId, slot)` ComfyUI should see. Handles:
 *  - Reroute pass-through
 *  - LiteGraph mode 4 (bypass): reroutes by matching the requested output type
 *    to an input of the same type; falls back to the first connected input.
 *  - PrimitiveNode: inlines `widgets_values[0]` as a literal.
 *  - GetNode: traces to the matching SetNode's input source via setterMap.
 *  - Muted (mode 2) nodes already absent from `nodes`; return null for safety.
 */
function resolveInput(linkId: number, ctx: ResolveCtx): InputResolution | null {
  const visited = new Set<number>();
  let currentId = linkId;
  while (true) {
    if (visited.has(currentId)) return null;
    visited.add(currentId);
    const link = ctx.linkMap.get(currentId);
    if (!link) return null;
    const origin = ctx.nodes.get(link.origin_id);
    if (!origin) return { kind: 'ref', nodeId: link.origin_id, slot: link.origin_slot };
    if (origin.mode === 2) return null;

    if (origin.type === 'Reroute') {
      const next = origin.inputs?.[0]?.link;
      if (next == null) return null;
      currentId = next;
      continue;
    }

    if (origin.type === 'PrimitiveNode' || origin.type === 'PrimitiveInt' || origin.type === 'PrimitiveFloat' || origin.type === 'PrimitiveBoolean' || origin.type === 'PrimitiveString' || origin.type === 'PrimitiveStringMultiline') {
      // UI-only primitive value holder — inline its literal widget value.
      return { kind: 'literal', value: origin.widgets_values?.[0] };
    }

    if (origin.type === 'GetNode' || origin.type === 'easy getNode') {
      const varName = origin.widgets_values?.[0] as string | undefined;
      if (!varName) return null;
      return ctx.setterMap.get(varName) ?? null;
    }

    if (origin.mode === 4) {
      // Bypassed — find input whose type matches the requested output slot.
      const info = ctx.objectInfo[origin.type] as {
        input?: { required?: Record<string, unknown[]>; optional?: Record<string, unknown[]> };
        output?: string[];
      } | undefined;
      const targetType = info?.output?.[link.origin_slot];
      const allInputs = { ...(info?.input?.required || {}), ...(info?.input?.optional || {}) };
      let nextLink: number | null = null;
      if (targetType) {
        for (const inp of origin.inputs || []) {
          if (inp.link == null) continue;
          const spec = allInputs[inp.name] as unknown[] | undefined;
          if (spec?.[0] === targetType) { nextLink = inp.link; break; }
        }
      }
      if (nextLink == null) {
        // Fall back to the first connected input.
        const fb = (origin.inputs || []).find(i => i.link != null);
        if (fb?.link != null) nextLink = fb.link;
      }
      if (nextLink == null) return null;
      currentId = nextLink;
      continue;
    }

    return { kind: 'ref', nodeId: link.origin_id, slot: link.origin_slot };
  }
}

/** Pre-compute SetNode variable bindings so GetNode lookups are O(1). */
function buildSetterMap(ctx: Omit<ResolveCtx, 'setterMap'>): Map<string, InputResolution> {
  const setterMap = new Map<string, InputResolution>();
  for (const node of ctx.nodes.values()) {
    if (node.type !== 'SetNode' && node.type !== 'easy setNode') continue;
    const varName = node.widgets_values?.[0] as string | undefined;
    if (!varName) continue;
    const firstInput = node.inputs?.find(i => i.link != null);
    if (!firstInput?.link) continue;
    // Temporarily pass an empty setterMap to avoid circular deps between SetNodes.
    const resolved = resolveInput(firstInput.link, { ...ctx, setterMap: new Map() });
    if (resolved) setterMap.set(varName, resolved);
  }
  return setterMap;
}

interface FormInputBinding {
  id: string;
  type: string;
  nodeId?: number;
  nodeType?: string;
  mediaType?: string;
}

// Convert a UI-format workflow JSON to ComfyUI API prompt format.
// Handles arbitrarily nested subgraphs and Reroute pass-through nodes.
async function workflowToApiPrompt(
  wf: Record<string, unknown>,
  userInputs: Record<string, unknown>,
  formInputs: FormInputBinding[] = [],
): Promise<Record<string, { class_type: string; inputs: Record<string, unknown>; _meta?: { title: string } }>> {
  const objectInfo = await getObjectInfo();
  const prompt: Record<string, { class_type: string; inputs: Record<string, unknown>; _meta?: { title: string } }> = {};

  // 1. Flatten the workflow (subgraph wrappers replaced by their contents, links rewired).
  const { nodes, links } = flattenWorkflow(wf);
  const linkMap = new Map<number, FlatLink>();
  for (const l of links) linkMap.set(l.id, l);

  // Mutate PrimitiveString* holders with the user-provided prompt BEFORE the build step,
  // so inlining downstream automatically carries the new text. (These nodes are UI-only and
  // won't appear in the prompt themselves, but their widgets_values[0] is what gets inlined.)
  const userPromptText = userInputs.prompt;
  if (typeof userPromptText === 'string' && userPromptText.length > 0) {
    for (const node of nodes.values()) {
      if (node.type === 'PrimitiveString' || node.type === 'PrimitiveStringMultiline') {
        node.widgets_values = [userPromptText];
      }
    }
  }

  // Pre-compute SetNode bindings so GetNode lookups are O(1) during resolution.
  const resolveCtxBase = { linkMap, nodes, objectInfo };
  const setterMap = buildSetterMap(resolveCtxBase);
  const ctx: ResolveCtx = { ...resolveCtxBase, setterMap };

  // Node types that exist only in the UI graph and must never appear in the API prompt.
  const UI_ONLY_TYPES = new Set([
    'Reroute', 'PrimitiveNode',
    'PrimitiveInt', 'PrimitiveFloat', 'PrimitiveBoolean', 'PrimitiveString', 'PrimitiveStringMultiline',
    'GetNode', 'SetNode', 'easy getNode', 'easy setNode',
  ]);

  // 2. Emit API prompt entries for each real node. Pass-through/UI-only types are skipped.
  for (const [id, node] of nodes.entries()) {
    if (UI_ONLY_TYPES.has(node.type)) continue;
    if (node.mode === 2) continue; // muted (defensive — already filtered in flatten)
    const info = objectInfo[node.type];
    if (!info) continue;

    const inputs: Record<string, unknown> = {};

    // Resolve each link through Reroute / bypass / Primitive / Get-Set chains.
    for (const inp of node.inputs) {
      if (inp.link == null) continue;
      const resolved = resolveInput(inp.link, ctx);
      if (!resolved) continue;
      inputs[inp.name] = resolved.kind === 'literal'
        ? resolved.value
        : [resolved.nodeId, resolved.slot];
    }

    // Widget values, with proxyWidget overrides from the wrapper(s) above.
    // Fall back to the object_info `default` when a widget was added to the node definition
    // after the template was saved (common for `advanced: true` flags).
    const apiWidgets = getApiWidgetNames(objectInfo, node.type);
    const wv = node.widgets_values.filter(v => !FRONTEND_ONLY_VALUES.has(v as string));
    const required = (info as { input?: { required?: Record<string, unknown[]> } }).input?.required || {};
    for (let i = 0; i < apiWidgets.length; i++) {
      const name = apiWidgets[i];
      if (name in inputs) continue;
      if (node.overrides && name in node.overrides) {
        inputs[name] = node.overrides[name];
        continue;
      }
      if (i < wv.length) {
        inputs[name] = wv[i];
        continue;
      }
      const spec = required[name] as unknown[] | undefined;
      const cfg = spec?.[1] as Record<string, unknown> | undefined;
      if (cfg && 'default' in cfg) inputs[name] = cfg.default;
    }

    const displayTitle = node.title?.trim() || ((info as { display_name?: string } | undefined)?.display_name) || node.type;
    prompt[id] = { class_type: node.type, inputs, _meta: { title: displayTitle } };
  }

  // 3. Apply user-supplied inputs.
  //
  // Structured form fields (image/audio/video) carry an explicit `nodeId` from the template
  // metadata — use that directly. For the generic `prompt` field the template doesn't bind a
  // node, so we fall back to scanning for nodes that expose a `text` or `prompt` widget (or
  // PrimitiveString* holders), and write the user's prompt into all of them.
  for (const binding of formInputs) {
    const val = userInputs[binding.id];
    if (val == null) continue;
    if (binding.nodeId == null) continue;
    // The flattener uses path-prefixed IDs; top-level nodes' global ID == String(nodeId).
    const entry = prompt[String(binding.nodeId)];
    if (!entry) continue;
    if (binding.mediaType === 'image') {
      entry.inputs['image'] = val;
      entry.inputs['upload'] = 'image';
    } else if (binding.mediaType === 'audio') {
      entry.inputs['audio'] = val;
      entry.inputs['upload'] = 'audio';
    } else if (binding.mediaType === 'video') {
      entry.inputs['video'] = val;
      entry.inputs['upload'] = 'video';
    }
  }

  // Prompt text has no explicit binding in formInputs, so:
  //  - For PrimitiveString* holders (UI-only, inlined as literals): mutate their widgets_values
  //    BEFORE the prompt was built — skipped here since we build above. We fall through to the
  //    encoder-widget path which is the only remaining in-prompt destination.
  //  - For any real node whose schema has a `text` or `prompt` widget: write the user prompt in.
  const promptText = userInputs.prompt;
  if (promptText != null && promptText !== '') {
    for (const [id, nodeData] of Object.entries(prompt)) {
      const node = nodes.get(id);
      if (!node) continue;
      const required = (objectInfo[node.type] as { input?: { required?: Record<string, unknown[]> } } | undefined)?.input?.required || {};
      if ('text' in required) nodeData.inputs['text'] = promptText;
      else if ('prompt' in required) nodeData.inputs['prompt'] = promptText;
    }
  }

  // Randomize seed for samplers (avoid deterministic repeats between runs).
  for (const nodeData of Object.values(prompt)) {
    if (nodeData.class_type === 'KSampler' || nodeData.class_type === 'RandomNoise') {
      const seedKey = nodeData.class_type === 'RandomNoise' ? 'noise_seed' : 'seed';
      nodeData.inputs[seedKey] = Math.floor(Math.random() * 2147483647);
    }
  }

  return prompt;
}

router.post('/generate', async (req: Request, res: Response) => {
  try {
    const { templateName, inputs: userInputs, advancedSettings } = req.body;
    if (!templateName) {
      res.status(400).json({ error: 'templateName is required' });
      return;
    }

    // 1. Fetch the workflow JSON from ComfyUI
    const wfRes = await fetch(`${COMFYUI_URL}/templates/${encodeURIComponent(templateName)}.json`);
    if (!wfRes.ok) {
      res.status(404).json({ error: 'Workflow not found' });
      return;
    }
    const workflow = await wfRes.json();

    // 2. Apply advanced settings overrides to the wrapper node's widgets_values
    if (advancedSettings && typeof advancedSettings === 'object') {
      const topNodes = (workflow.nodes || []) as Array<Record<string, unknown>>;
      for (const node of topNodes) {
        const props = node.properties as Record<string, unknown> | undefined;
        if (props?.proxyWidgets && Array.isArray(props.proxyWidgets)) {
          const wv = (node.widgets_values || []) as unknown[];
          for (const [key, val] of Object.entries(advancedSettings as Record<string, { proxyIndex: number; value: unknown }>)) {
            if (val && typeof val === 'object' && 'proxyIndex' in val && val.proxyIndex < wv.length) {
              wv[val.proxyIndex] = val.value;
            }
          }
          node.widgets_values = wv;
          break;
        }
      }
    }

    // 3. Convert to API prompt format with user inputs injected, using the template's
    //    own formInputs bindings so each user value lands on the node the template declared.
    const template = templates.getTemplate(templateName);
    const apiPrompt = await workflowToApiPrompt(workflow, userInputs || {}, template?.formInputs || []);

    // 4. Submit to ComfyUI — attach Comfy Org API key only for API-node workflows
    const attachApiKey = template?.openSource === false;
    const result = await comfyui.submitPrompt(apiPrompt, { attachApiKey });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Generation failed', detail: String(err) });
  }
});

// Queue status
router.get('/queue', async (_req: Request, res: Response) => {
  try {
    const queue = await comfyui.getQueue();
    res.json(queue);
  } catch {
    res.json({ queue_running: 0, queue_pending: 0 });
  }
});

// History
router.get('/history', async (_req: Request, res: Response) => {
  try {
    const history = await comfyui.getHistory();
    res.json(history);
  } catch {
    res.json({});
  }
});

// Get outputs for a specific prompt
router.get('/history/:promptId', async (req: Request, res: Response) => {
  try {
    const data = await comfyui.fetchComfyUI<Record<string, { outputs?: Record<string, { images?: Array<{ filename: string; subfolder: string; type: string }>; videos?: Array<{ filename: string; subfolder: string; type: string }> }> }>>(`/api/history/${req.params.promptId}`);
    const entry = data[req.params.promptId as string];
    if (!entry?.outputs) {
      res.json({ outputs: [] });
      return;
    }
    // Flatten all output images/videos
    const outputs: Array<{ filename: string; subfolder: string; type: string; mediaType: string }> = [];
    for (const nodeOutput of Object.values(entry.outputs)) {
      for (const img of nodeOutput.images || []) {
        outputs.push({ ...img, mediaType: 'image' });
      }
      for (const vid of nodeOutput.videos || []) {
        outputs.push({ ...vid, mediaType: 'video' });
      }
    }
    res.json({ outputs });
  } catch {
    res.json({ outputs: [] });
  }
});

// Models (list from ComfyUI or mock)
router.get('/models', async (_req: Request, res: Response) => {
  try {
    res.json([
      { name: 'flux1-dev.safetensors', type: 'checkpoint', size: 23_800_000_000, path: 'checkpoints/flux1-dev.safetensors' },
      { name: 'wan2.2.safetensors', type: 'checkpoint', size: 14_200_000_000, path: 'checkpoints/wan2.2.safetensors' },
      { name: 'ace-step-v1.5.safetensors', type: 'checkpoint', size: 3_400_000_000, path: 'checkpoints/ace-step-v1.5.safetensors' },
      { name: 'realesrgan-x4plus.pth', type: 'upscale', size: 64_000_000, path: 'upscale_models/realesrgan-x4plus.pth' },
      { name: 'control_v11p_sd15_canny.pth', type: 'controlnet', size: 1_450_000_000, path: 'controlnet/control_v11p_sd15_canny.pth' },
      { name: 'flux-vae.safetensors', type: 'vae', size: 335_000_000, path: 'vae/flux-vae.safetensors' },
      { name: 'style-anime-v1.safetensors', type: 'lora', size: 150_000_000, path: 'loras/style-anime-v1.safetensors' },
    ]);
  } catch {
    res.json([]);
  }
});

// Gallery
router.get('/gallery', async (_req: Request, res: Response) => {
  try {
    res.json(await comfyui.getGalleryItems());
  } catch {
    res.json([]);
  }
});

// View proxy (proxy image/video from ComfyUI)
router.get('/view', async (req: Request, res: Response) => {
  try {
    const filename = req.query.filename as string;
    const subfolder = req.query.subfolder as string | undefined;
    if (!filename) {
      res.status(400).json({ error: 'filename required' });
      return;
    }
    const upstream = await comfyui.proxyView(filename, subfolder);
    const contentType = upstream.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    const buffer = await upstream.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch {
    res.status(502).json({ error: 'Cannot fetch from ComfyUI' });
  }
});

// Upload proxy
// Upload an image to ComfyUI's input folder. Parse the multipart body on our side, then
// re-POST as multipart to ComfyUI's /api/upload/image so it lands in the right place.
router.post('/upload', upload.single('image'), async (req: Request, res: Response) => {
  try {
    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file) {
      res.status(400).json({ error: 'No image file provided' });
      return;
    }
    const form = new FormData();
    const blob = new Blob([new Uint8Array(file.buffer)], { type: file.mimetype });
    form.append('image', blob, file.originalname);
    const upstream = await fetch(`${COMFYUI_URL}/api/upload/image`, { method: 'POST', body: form });
    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      res.status(upstream.status).json({ error: 'ComfyUI rejected upload', detail });
      return;
    }
    res.json(await upstream.json());
  } catch (err) {
    res.status(500).json({ error: 'Upload failed', detail: String(err) });
  }
});

// ---- Launcher process-control proxy routes ----

router.get('/launcher/status', async (_req: Request, res: Response) => {
  try {
    const data = await proxyToLauncher('/api/status');
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Cannot reach launcher', detail: String(err) });
  }
});

router.post('/launcher/start', async (req: Request, res: Response) => {
  try {
    const data = await proxyToLauncher('/api/start', 'POST', req.body);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Cannot reach launcher', detail: String(err) });
  }
});

router.post('/launcher/stop', async (req: Request, res: Response) => {
  try {
    const data = await proxyToLauncher('/api/stop', 'POST', req.body);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Cannot reach launcher', detail: String(err) });
  }
});

router.post('/launcher/restart', async (req: Request, res: Response) => {
  try {
    const data = await proxyToLauncher('/api/restart', 'POST', req.body);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Cannot reach launcher', detail: String(err) });
  }
});

router.get('/launcher/comfyui/logs', async (_req: Request, res: Response) => {
  try {
    const data = await proxyToLauncher('/api/comfyui/logs');
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Cannot reach launcher', detail: String(err) });
  }
});

router.get('/launcher/resource-packs', async (_req: Request, res: Response) => {
  try {
    const data = await proxyToLauncher('/api/resource-packs');
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Cannot reach launcher', detail: String(err) });
  }
});

// ---- Launcher model proxy routes ----

router.get('/launcher/models', async (_req: Request, res: Response) => {
  try {
    const data = await proxyToLauncher('/api/models');
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Cannot reach launcher', detail: String(err) });
  }
});

router.post('/launcher/models/install/:modelName', async (req: Request, res: Response) => {
  try {
    const modelName = req.params.modelName as string;
    const { filename } = (req.body || {}) as { filename?: string };
    // Dedup: if a download for this model is already active, return its taskId instead of starting a second one.
    const existing = findByIdentity({ modelName, filename });
    if (existing) {
      res.json({ success: true, taskId: existing.taskId, alreadyActive: true });
      return;
    }
    const data = await proxyToLauncher(
      `/api/models/install/${encodeURIComponent(modelName)}`,
      'POST',
      req.body
    ) as { taskId?: string };
    if (data?.taskId) trackDownload(data.taskId, { modelName, filename });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Cannot reach launcher', detail: String(err) });
  }
});

router.get('/launcher/models/progress/:id', async (req: Request, res: Response) => {
  try {
    const r = await fetch(`${LAUNCHER_URL}/api/models/progress/${encodeURIComponent(req.params.id as string)}`);
    if (r.status === 404) {
      // Task ID not found — lost track, don't assume completed
      res.json({ overallProgress: 0, status: 'unknown', completed: false, error: 'Task not found', totalBytes: 0, downloadedBytes: 0, speed: 0 });
      return;
    }
    if (!r.ok) throw new Error(`Launcher API error: ${r.status}`);
    res.json(await r.json());
  } catch (err) {
    res.status(502).json({ error: 'Cannot reach launcher', detail: String(err) });
  }
});

router.post('/launcher/models/cancel-download', async (req: Request, res: Response) => {
  try {
    const { taskId } = (req.body || {}) as { taskId?: string };
    const data = await proxyToLauncher('/api/models/cancel-download', 'POST', req.body);
    if (taskId) stopTracking(taskId);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Cannot reach launcher', detail: String(err) });
  }
});

router.post('/launcher/models/delete', async (req: Request, res: Response) => {
  try {
    const data = await proxyToLauncher('/api/models/delete', 'POST', req.body);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Cannot reach launcher', detail: String(err) });
  }
});

router.post('/launcher/models/scan', async (_req: Request, res: Response) => {
  try {
    const data = await proxyToLauncher('/api/models/scan', 'POST');
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Cannot reach launcher', detail: String(err) });
  }
});

router.post('/launcher/models/download-custom', async (req: Request, res: Response) => {
  try {
    const { modelName, filename, hfUrl, modelDir } = (req.body || {}) as { modelName?: string; filename?: string; hfUrl?: string; modelDir?: string };
    const resolvedFilename = filename || hfUrl?.split('/').pop();
    // Dedup against active downloads.
    const existing = findByIdentity({ modelName, filename: resolvedFilename });
    if (existing) {
      res.json({ success: true, taskId: existing.taskId, alreadyActive: true });
      return;
    }
    // Dedup against the queue (same model already waiting for a slot).
    const queued = findQueuedByIdentity({ modelName, filename: resolvedFilename });
    if (queued) {
      res.json({ success: true, taskId: queued.synthId, queued: true });
      return;
    }
    // At capacity → enqueue and let the backend start it when a slot frees.
    if (isAtCapacity() && hfUrl && modelDir) {
      const synthId = enqueueDownload({ hfUrl, modelDir, modelName, filename: resolvedFilename });
      res.json({ success: true, taskId: synthId, queued: true });
      return;
    }
    // Forward to the launcher immediately, injecting the HuggingFace token when one is
    // stored — the launcher adds it as `Authorization: Bearer` on HEAD + GET so gated
    // repos return 200 instead of 401.
    const hfToken = settings.getHfToken();
    const payload: Record<string, unknown> = { ...req.body };
    if (hfToken && hfUrl && /huggingface\.co/.test(hfUrl)) {
      payload.hfToken = hfToken;
    }
    const data = await proxyToLauncher('/api/models/download-custom', 'POST', payload) as { taskId?: string };
    if (data?.taskId) {
      trackDownload(data.taskId, { modelName, filename: resolvedFilename });
    }
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Cannot reach launcher', detail: String(err) });
  }
});

// Expose current in-progress downloads (used as a fallback; WS snapshot on connect is primary).
router.get('/downloads', (_req: Request, res: Response) => {
  res.json(getAllDownloads());
});

router.get('/launcher/models/download-history', async (_req: Request, res: Response) => {
  try {
    const data = await proxyToLauncher('/api/models/download-history');
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Cannot reach launcher', detail: String(err) });
  }
});

// ---- Launcher settings proxy routes ----

router.get('/launcher/comfyui/launch-options', async (_req: Request, res: Response) => {
  try {
    const data = await proxyToLauncher('/api/comfyui/launch-options');
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Cannot reach launcher', detail: String(err) });
  }
});

router.put('/launcher/comfyui/launch-options', async (req: Request, res: Response) => {
  try {
    const data = await proxyToLauncher('/api/comfyui/launch-options', 'PUT', req.body);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Cannot reach launcher', detail: String(err) });
  }
});

router.post('/launcher/comfyui/launch-options/reset', async (_req: Request, res: Response) => {
  try {
    const data = await proxyToLauncher('/api/comfyui/launch-options/reset', 'POST');
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Cannot reach launcher', detail: String(err) });
  }
});

router.get('/launcher/system/network-config', async (_req: Request, res: Response) => {
  try {
    const data = await proxyToLauncher('/api/system/network-config');
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Cannot reach launcher', detail: String(err) });
  }
});

router.post('/launcher/system/huggingface-endpoint', async (req: Request, res: Response) => {
  try {
    const data = await proxyToLauncher('/api/system/huggingface-endpoint', 'POST', req.body);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Cannot reach launcher', detail: String(err) });
  }
});

router.post('/launcher/system/github-proxy', async (req: Request, res: Response) => {
  try {
    const data = await proxyToLauncher('/api/system/github-proxy', 'POST', req.body);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Cannot reach launcher', detail: String(err) });
  }
});

router.post('/launcher/system/pip-source', async (req: Request, res: Response) => {
  try {
    const data = await proxyToLauncher('/api/system/pip-source', 'POST', req.body);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Cannot reach launcher', detail: String(err) });
  }
});

// ---- Workflow JSON proxy ----

router.get('/workflow/:name', async (req: Request, res: Response) => {
  try {
    const name = req.params.name as string;
    const upstream = await fetch(`${COMFYUI_URL}/templates/${encodeURIComponent(name)}.json`);
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: `Workflow not found: ${name}` });
      return;
    }
    const data = await upstream.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Cannot fetch workflow', detail: String(err) });
  }
});

// ---- Dependency checking ----

// Known loader node types that reference model filenames in widgets_values
const LOADER_TYPES = new Set([
  'UNETLoader',
  'VAELoader',
  'CLIPLoader',
  'LoraLoaderModelOnly',
  'CheckpointLoaderSimple',
  'LoraLoader',
  'DualCLIPLoader',
]);

interface WorkflowNode {
  type?: string;
  class_type?: string;
  properties?: {
    models?: Array<{ name: string; url: string; directory: string }>;
    [key: string]: unknown;
  };
  widgets_values?: unknown[];
  [key: string]: unknown;
}

interface LauncherModelEntry {
  name: string;
  type: string;
  filename: string;
  url: string;
  size?: string;
  fileSize?: number;
  installed: boolean;
  save_path?: string;
}

interface RequiredModelInfo {
  name: string;
  directory: string;
  url: string;
  size?: number;
  /** Pretty-formatted size string (e.g. "9.14 GB"), derived from catalog's size_bytes. */
  size_pretty?: string;
  installed: boolean;
  gated?: boolean;
  gated_message?: string;
}

/**
 * Recursively collect every node from a workflow (top-level + every nested subgraph).
 * Needed because templates frequently stash loader nodes two or three subgraph levels deep.
 */
function collectAllWorkflowNodes(wf: Record<string, unknown>): WorkflowNode[] {
  const out: WorkflowNode[] = [];
  const walk = (nodes: unknown[]): void => {
    for (const raw of nodes) {
      const n = raw as WorkflowNode & { subgraph?: { nodes?: unknown[] } };
      out.push(n);
      if (n.subgraph && Array.isArray(n.subgraph.nodes)) walk(n.subgraph.nodes);
    }
  };
  if (Array.isArray(wf.nodes)) walk(wf.nodes);
  const defs = (wf.definitions as Record<string, unknown> | undefined)?.subgraphs;
  if (Array.isArray(defs)) {
    for (const sg of defs as Array<Record<string, unknown>>) {
      if (Array.isArray(sg.nodes)) walk(sg.nodes as unknown[]);
    }
  }
  return out;
}

router.post('/check-dependencies', async (req: Request, res: Response) => {
  try {
    const { templateName } = req.body;
    if (!templateName) {
      res.status(400).json({ error: 'templateName is required' });
      return;
    }

    // 1. Fetch workflow JSON from ComfyUI.
    let allNodes: WorkflowNode[] = [];
    try {
      const wfRes = await fetch(`${COMFYUI_URL}/templates/${encodeURIComponent(templateName)}.json`);
      if (wfRes.ok) {
        const wfData = await wfRes.json();
        if (wfData && typeof wfData === 'object') {
          allNodes = collectAllWorkflowNodes(wfData as Record<string, unknown>);
        }
      }
    } catch {
      // Workflow not available — nothing to check.
    }
    if (allNodes.length === 0) {
      res.json({ ready: true, required: [], missing: [] });
      return;
    }

    // 2. Make sure our catalog has been seeded (no-op after first call).
    await catalog.seedFromComfyUI();

    // 3. Walk every node; upsert each declared `properties.models[]` entry into our catalog
    //    (template URL wins), then record as required. Fallback: for loader nodes with a
    //    `widgets_values` filename but no `properties.models`, look the filename up in the
    //    existing catalog (seeded from ComfyUI) to still discover a URL.
    const requiredFilenames = new Set<string>();
    // Per-filename directory as declared by the template itself (not the catalog cache).
    // This wins over cat.save_path when we build the RequiredModelInfo response, so the
    // launcher saves to exactly where the template's widget_values expects to find it.
    const templateDirByFilename = new Map<string, string>();

    for (const node of allNodes) {
      const nodeTemplateModels = (node.properties as Record<string, unknown> | undefined)?.models;
      if (Array.isArray(nodeTemplateModels)) {
        for (const raw of nodeTemplateModels as Array<Record<string, unknown>>) {
          const name = raw.name as string | undefined;
          const url = raw.url as string | undefined;
          const dir = raw.directory as string | undefined;
          if (!name) continue;
          if (dir) templateDirByFilename.set(name, dir);
          if (url) {
            catalog.upsertModel({
              filename: name,
              name,
              type: dir || 'other',
              save_path: dir || 'checkpoints',
              url,
              description: raw.description as string | undefined,
              source: `template:${templateName}`,
            });
          }
          requiredFilenames.add(name);
        }
      }

      const nodeType = (node.type as string | undefined) || (node.class_type as string | undefined) || '';
      if (LOADER_TYPES.has(nodeType) && Array.isArray(node.widgets_values)) {
        for (const val of node.widgets_values) {
          if (typeof val !== 'string') continue;
          if (!/\.(safetensors|pth|ckpt|pt|bin)$/i.test(val)) continue;
          requiredFilenames.add(val);
        }
      }
    }

    if (requiredFilenames.size === 0) {
      res.json({ ready: true, required: [], missing: [] });
      return;
    }

    // 3b. Bring every required model's catalog entry up to date: fires HEAD requests
    //     (capped concurrency) for entries whose size_bytes is 0 or older than the
    //     staleness window. This populates real sizes and flips `gated: true` with
    //     the HF `x-error-message` verbatim, so the modal shows accurate info on first render.
    const toRefresh = Array.from(requiredFilenames).filter(fn => {
      const entry = catalog.getModel(fn);
      return entry ? catalog.isSizeStale(entry) : false;
    });
    if (toRefresh.length > 0) {
      await catalog.refreshMany(toRefresh, { concurrency: 4 });
    }

    // 4. Check installation by asking the launcher what's on disk right now.
    let installedModels: LauncherModelEntry[] = [];
    try {
      const launcherRes = await fetch(`${LAUNCHER_URL}/api/models`);
      if (launcherRes.ok) {
        const data = await launcherRes.json();
        if (Array.isArray(data)) installedModels = data;
      }
    } catch { /* launcher down → assume nothing installed */ }
    const installedSet = new Set<string>();
    for (const m of installedModels) {
      if (m.installed) {
        installedSet.add(m.filename);
        installedSet.add(m.name);
      }
    }

    // 5. For each required filename produce a RequiredModelInfo sourced from our catalog.
    const required: RequiredModelInfo[] = [];
    const missing: RequiredModelInfo[] = [];

    for (const filename of requiredFilenames) {
      const cat = catalog.getModel(filename);
      const scanEntry = installedModels.find(m => m.filename === filename || m.name === filename);
      const isInstalled = installedSet.has(filename);
      const entry: RequiredModelInfo = {
        name: filename,
        url: cat?.url || '',
        // Template's own directory takes precedence over any cached save_path.
        directory: templateDirByFilename.get(filename) || cat?.save_path || scanEntry?.type || '',
        size: cat?.size_bytes || scanEntry?.fileSize || undefined,
        size_pretty: cat?.size_pretty || undefined,
        installed: isInstalled,
        gated: cat?.gated,
        gated_message: cat?.gated_message,
      };
      required.push(entry);
      if (!isInstalled) missing.push(entry);
    }

    res.json({ ready: missing.length === 0, required, missing });
  } catch (err) {
    res.status(500).json({ error: 'Dependency check failed', detail: String(err) });
  }
});

// ---- Generic launcher proxy ----
// Forwards any /launcher/* request to the launcher's matching /api/* path.
// Runs after all specific /launcher/* routes so those keep their custom handling;
// this catches everything else (plugins, python, civitai, resource-packs, essential
// models, system endpoints, reset, etc.) without needing per-endpoint boilerplate.
router.all('/launcher/*', async (req: Request, res: Response) => {
  const launcherPath = '/api' + req.path.replace(/^\/launcher/, '');
  const query = Object.keys(req.query).length > 0
    ? '?' + new URLSearchParams(req.query as Record<string, string>).toString()
    : '';
  const init: RequestInit = {
    method: req.method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (!['GET', 'HEAD'].includes(req.method)) {
    init.body = JSON.stringify(req.body);
  }
  try {
    const upstream = await fetch(`${LAUNCHER_URL}${launcherPath}${query}`, init);
    res.status(upstream.status);
    const contentType = upstream.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      res.json(await upstream.json());
    } else {
      res.send(await upstream.text());
    }
  } catch (err) {
    res.status(502).json({ error: 'Cannot reach launcher', detail: String(err) });
  }
});

export default router;
