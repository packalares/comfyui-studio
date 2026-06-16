// POST /api/generate — inline pipeline submit. Translates form inputs into a
// ComfyUI API-format prompt and submits it. Chat-tool callers use submitTemplate
// directly; this route is the UI's direct submit path (widget keys like `text`,
// `image`, `audio` rather than the chat contract's `prompt`).

import { createHash } from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../lib/defineRoute.js';
import { NotFoundError, ValidationError, UpstreamUnavailableError } from '../lib/errors.js';
import * as comfyui from '../services/comfyui/api.js';
import * as templates from '../services/templates/index.js';
import { generateFormInputs } from '../services/templates/templates.formInputs.js';
import type { RawTemplate } from '../services/templates/types.js';
import { getObjectInfo, workflowToApiPrompt } from '../services/workflow/index.js';
import { computeFgmMutedNodes } from '../services/workflow/fgmMute.js';
import { injectEnhancerProbes } from '../services/workflow/prompt/enhancerProbe.js';
import { schedulePromptWatch } from '../services/gallery/sentry.js';
import { insertSnapshot } from '../lib/db/promptSnapshots.repo.js';
import { computeModelFingerprint } from '../services/templates/submitTemplate.js';
import {
  applyNodeOverrides,
  applyProxyOverrides,
  splitAdvancedSettings,
} from '../services/templates/advancedSettings.js';
import { getBridgeClientId, trackComfyPrompt } from '../services/videoboard/comfyJobBridge.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { GenerateBodySchema, GenerateResponseSchema } from '../contracts/generate.contract.js';
import { submitGpuJob } from '../services/gpu/scheduler.js';
import { buildJobUrls } from '../services/jobs/urls.js';

const generateLimiter = rateLimit('generate');

interface NodeErrorRow { nodeId: string; classType?: string; message: string; details?: string; }

function parseComfyValidation(body: string): { summary: string; nodeErrors: NodeErrorRow[] } | null {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as {
    error?: { message?: string; type?: string };
    node_errors?: Record<string, { errors?: Array<{ message?: string; details?: string; type?: string }>; class_type?: string }>;
  };
  const summary = p.error?.message || p.error?.type || 'Workflow validation failed';
  const nodeErrors: NodeErrorRow[] = [];
  if (p.node_errors) {
    for (const [nodeId, info] of Object.entries(p.node_errors)) {
      for (const e of info?.errors ?? []) {
        nodeErrors.push({ nodeId, classType: info?.class_type, message: e?.message || e?.type || 'Invalid input', details: e?.details });
      }
    }
  }
  if (nodeErrors.length === 0 && !p.error) return null;
  return { summary, nodeErrors };
}

const generateRoute = defineRoute({
  method: 'POST',
  path: '/generate',
  body: GenerateBodySchema,
  response: GenerateResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
  tags: ['generate'],
  summary: 'Submit a workflow prompt to ComfyUI',
}, async ({ body, ok }) => {
  const { templateName, inputs: userInputs, advancedSettings, mode: bodyMode } = body;
  let mode = bodyMode;

  const workflow = templates.getUserWorkflowJson(templateName);
  if (!workflow) throw new NotFoundError('Workflow file missing or unreadable');

  const templateHash = createHash('sha1')
    .update(JSON.stringify(workflow))
    .digest('hex')
    .slice(0, 16);

  const { proxyEntries, nodeOverrides } = splitAdvancedSettings(advancedSettings);
  applyProxyOverrides(workflow, proxyEntries);

  const template = templates.getUserTemplate(templateName);

  // ---- Prompt-trigger mode override ----
  // Scan the prompt text for any `triggers` declared on a studioMode. First
  // case-insensitive substring match wins → override `mode` AND strip the
  // matched substring from the prompt before any further processing (mode
  // routing, FGM mute, workflow conversion). When no trigger matches, the
  // UI-supplied mode stands.
  const promptKey = template?.studioInputMap?.text ? 'text'
    : 'text' in (userInputs as Record<string, unknown>) ? 'text' : null;
  if (promptKey && template?.studioModes) {
    const rawPrompt = (userInputs as Record<string, unknown>)[promptKey];
    if (typeof rawPrompt === 'string') {
      const hit = findTriggerHit(rawPrompt, template.studioModes);
      if (hit) {
        mode = hit.mode;
        (userInputs as Record<string, unknown>)[promptKey] = hit.cleaned;
      }
    }
  }

  const objectInfo = await getObjectInfo();
  const rawForBindings: RawTemplate = {
    name: templateName,
    title: template?.title ?? templateName,
    description: template?.description ?? '',
    mediaType: template?.mediaType ?? 'image',
    tags: template?.tags ?? [],
    models: template?.models ?? [],
    io: template?.io,
  };
  const mergedFormInputs = generateFormInputs(rawForBindings, workflow, objectInfo);

  // ---- Easy-mode input-key rename ----
  // VideoBuilder (and future Image/Audio builders) send semantic keys like
  // `image` / `audio` / `lastFrame`. The template's form-input generator
  // produces indexed keys like `image_0`, `audio_0`, `image_1`. Without
  // this rename, the Easy-mode upload doesn't match any form binding and
  // the LoadImage/LoadAudio widget stays unset — its downstream node fails
  // validation with "Required input is missing". The mapping is declared
  // per mode in studioModes[mode].inputMap so each template controls how
  // its inputs route to its specific LoadImage / LoadAudio nodes.
  // Merge shared studioInputMap (applies to all modes) with the per-mode
  // override. Per-mode entries win on key collisions.
  const shared = template?.studioInputMap ?? null;
  const perMode = (mode && template?.studioModes?.[mode]?.inputMap) || null;
  const renameMap = (shared || perMode)
    ? { ...(shared ?? {}), ...(perMode ?? {}) }
    : null;
  const finalInputs = renameMap
    ? Object.fromEntries(Object.entries(userInputs).map(
        ([k, v]) => [renameMap[k] ?? k, v],
      ))
    : userInputs;

  // ---- Title-search fallback for unmapped boolean inputs ----
  // Single-path routing: studioInputMap above is the EXPLICIT pointer; for
  // any boolean input it doesn't cover, fall back to a STRUCTURAL convention
  // — search the active mode's `enableGroups` for a switch-shaped node
  // whose title matches the input key (case-insensitive). When found, write
  // the boolean into the switch's first widget value BEFORE
  // workflowToApiPrompt runs, so the conversion picks it up naturally.
  //
  // Templates declare their toggles via `prompt_toggles` (the UI uses that
  // to know which keys to send); the server here is duck-typed — it tries
  // every boolean input key from the payload, not just the declared ones.
  // No match in the workflow → silently dropped, same as today.
  if (mode) {
    const tCfg = template?.studioModes?.[mode];
    if (tCfg) {
      applyTitleToggleSwitches(workflow, mode, tCfg, userInputs, renameMap ?? {});
    }
  }

  const apiPrompt = await workflowToApiPrompt(workflow, finalInputs, mergedFormInputs);
  applyNodeOverrides(apiPrompt, nodeOverrides);

  // Direct-write keys: any renamed key shaped like `<nodeId>:<widget>`
  // (e.g. `"401:value"`) doesn't correspond to a form-input id and is
  // skipped by applyBoundFormInputs. Apply it straight to the api-prompt
  // here. Lets studioInputMap target top-level non-Primitive nodes (Text
  // Multiline, etc.) without inventing a synthetic form-input entry.
  const directRe = /^(\d+(?::\d+)*):([a-zA-Z_][a-zA-Z0-9_]*)$/;
  for (const [key, value] of Object.entries(finalInputs)) {
    const m = directRe.exec(key);
    if (!m) continue;
    const node = (apiPrompt as Record<string, { inputs?: Record<string, unknown> }>)[m[1]];
    if (node?.inputs) node.inputs[m[2]] = value;
  }

  // ---- Easy-mode mute pass ----
  // When the UI sent a `mode` hint and the template declares matching
  // `studioModes` metadata, mute the inactive subgraph + input nodes and set the
  // switch widget value. ComfyUI's validator skips muted nodes entirely,
  // so the LoadImage/LoadAudio defaults in the inactive branches never
  // get checked for existence — solves the "placeholder file missing"
  // class of validation failures without changing the workflow JSON on
  // disk.
  const modeConfig = mode && template?.studioModes ? template.studioModes[mode] : undefined;
  if (modeConfig) {
    // FGM-derived mutes are computed BEFORE the explicit `mute` list is
    // applied, then merged in. Both paths share the same delete-from-
    // apiPrompt enforcement below, so they compose cleanly: a template can
    // use `enableGroups` to mute whole subgraphs by group AND keep a small
    // `mute: [id]` list for surgical per-node disables in the active group.
    const fgmMutes = mode
      ? computeFgmMutedNodes(workflow, mode, modeConfig)
      : [];
    const explicitMutes = Array.isArray(modeConfig.mute) ? modeConfig.mute : [];
    const combinedMutes: Array<number | string> =
      fgmMutes.length > 0 ? [...explicitMutes, ...fgmMutes] : explicitMutes;

    if (combinedMutes.length > 0) {
      // ComfyUI's API-prompt validator ignores per-node `mode` fields —
      // those are a frontend (LiteGraph) concept. To actually skip
      // validation of an inactive branch we have to DELETE its nodes
      // outright AND scrub any inputs in surviving nodes that referenced
      // the deleted ones (e.g. ImpactSwitch's input1/input2/input4 slots
      // would otherwise dangle and re-trigger validation).
      //
      // Each muteId from the combined list is a top-level node id; the
      // flattener turns subgraph instance children into compound keys like
      // `340:332`, so we expand each muteId to the bare key + every
      // `${muteId}:*` descendant.
      const prompt = apiPrompt as Record<string, { inputs?: Record<string, unknown> }>;
      const promptKeys = Object.keys(prompt);
      const toDelete = new Set<string>();
      for (const muteId of combinedMutes) {
        const bareKey = String(muteId);
        const prefix = `${bareKey}:`;
        for (const k of promptKeys) {
          if (k === bareKey || k.startsWith(prefix)) toDelete.add(k);
        }
      }
      for (const k of toDelete) delete prompt[k];
      // Scrub references to deleted nodes from every survivor's inputs.
      // ComfyUI input shape: a value is either a literal (string / number /
      // bool / etc.) OR a [sourceNodeId, slotIndex] tuple. We only strip
      // the tuple form whose source is in `toDelete`. Dynamic-input nodes
      // (ImpactSwitch, etc.) accept gaps; required-input nodes won't be
      // referencing a deleted subgraph in practice because the workflow
      // author put them on the active side.
      for (const node of Object.values(prompt)) {
        const inputs = node.inputs;
        if (!inputs) continue;
        for (const [name, val] of Object.entries(inputs)) {
          if (
            Array.isArray(val) && val.length === 2
            && typeof val[0] === 'string' && toDelete.has(val[0])
          ) {
            delete inputs[name];
          }
        }
      }
    }
    if (
      modeConfig.switchNodeId !== undefined &&
      modeConfig.switchSlot !== undefined
    ) {
      const swKey = String(modeConfig.switchNodeId);
      const swNode = (apiPrompt as Record<string, unknown>)[swKey] as
        | { inputs?: Record<string, unknown> }
        | undefined;
      // ImpactSwitch's `select` input is widget-backed; in API-shape, widget
      // values land inside `inputs`. Set the slot index (1-based per
      // ImpactSwitch convention) so the active subgraph's output reaches
      // the final SaveVideo / SaveImage node.
      if (swNode && swNode.inputs) {
        (swNode.inputs as Record<string, unknown>).select = modeConfig.switchSlot;
      }
    }
  }

  // Enhancer-probe injection runs HERE — after the directRe pass and after
  // the easy-mode mute pass — so the gating boolean
  // (studioInputMap-routed `enhance: false` → 424:445.value, etc.) is in its
  // final state. Injecting earlier inside `workflowToApiPrompt` would see
  // the workflow's baked-in default and add a probe even when the user
  // opted out of enhancement.
  injectEnhancerProbes(apiPrompt);

  const attachApiKey = template?.openSource === false;

  // Wrap the ComfyUI submission in the GPU scheduler slot.
  //
  // Slot lifetime is the ENTIRE execution (from POST to ComfyUI through
  // execution_success / error / cancelled / 30-min timeout) — not just the
  // submit step. That way, a second click on Generate queues in Studio's
  // scheduler instead of piling up in ComfyUI's own queue, and an Enhance
  // click during a running video waits for the video to finish before
  // unloadComfy() is allowed to fire.
  //
  // Two-promise dance: the route response goes back to the browser as soon
  // as ComfyUI accepts the prompt (so the UI gets its prompt_id to start WS
  // tracking), but the scheduler callback keeps awaiting trackComfyPrompt
  // so the slot stays held end-to-end. release() fires only after the
  // terminal event arrives.
  type SubmitResult = Awaited<ReturnType<typeof comfyui.submitPrompt>>;
  let resolveRoute!: (v: SubmitResult | Promise<SubmitResult>) => void;
  const routePromise = new Promise<SubmitResult>((r) => { resolveRoute = r; });
  // Kick off the scheduler job. Do NOT await — the slot stays held while
  // the callback awaits trackComfyPrompt. The route awaits routePromise
  // instead, which resolves the moment ComfyUI accepts the prompt.
  void submitGpuJob('comfy-generate', async (release) => {
    try {
      const submitResult = await comfyui.submitPrompt(apiPrompt, { attachApiKey, clientId: getBridgeClientId() });
      resolveRoute(submitResult); // UI gets its prompt_id NOW
      if (submitResult?.prompt_id) {
        await trackComfyPrompt(submitResult.prompt_id, { timeoutMs: 30 * 60 * 1000 })
          .catch(() => { /* terminal event: job done one way or another */ });
      }
      return submitResult;
    } catch (err) {
      resolveRoute(Promise.reject(err));
      throw err;
    } finally {
      release();
    }
  }).catch(() => { /* errors already routed via resolveRoute */ });
  let result: SubmitResult;
  try {
    result = await routePromise;
  } catch (err) {
    if (err instanceof comfyui.ComfyUIHttpError) {
      const parsed = parseComfyValidation(err.body);
      if (parsed && err.status >= 400 && err.status < 500) {
        throw new ValidationError(parsed.summary, { nodeErrors: parsed.nodeErrors, upstreamStatus: err.status });
      }
      throw new UpstreamUnavailableError('ComfyUI rejected the prompt', {
        detail: err.body.slice(0, 500) || err.message,
        upstreamStatus: err.status,
      });
    }
    throw err;
  }

  // Reject the submission if ComfyUI flagged any node_errors, even though it
  // accepted the prompt (HTTP 200 with prompt_id). ComfyUI's rule is "queue
  // if any output chain is valid" — a tolerant secondary output (e.g. a
  // Director text node) can make the prompt validate while the actual
  // SaveImage/SaveVideo chain is broken. Our UX contract is stricter: any
  // node_error = user-fixable problem = no submission. Cancel the queued
  // prompt so it doesn't burn a GPU slot on partial execution.
  const nodeErrorsMap = (result as { node_errors?: Record<string, unknown> } | null)?.node_errors;
  if (nodeErrorsMap && Object.keys(nodeErrorsMap).length > 0) {
    if (result?.prompt_id) {
      // deleteQueuedPrompts only removes from PENDING. If the worker already
      // picked it up (common — workers grab prompts within ms of submit),
      // we also need to /interrupt. cancelAcceptedPrompt does both.
      await comfyui.cancelAcceptedPrompt(result.prompt_id).catch(() => {
        /* best-effort cancel — surfacing a delete failure would mask the real validation error */
      });
    }
    const parsed = parseComfyValidation(JSON.stringify({ node_errors: nodeErrorsMap }));
    throw new ValidationError(parsed?.summary ?? 'Workflow validation failed', {
      nodeErrors: parsed?.nodeErrors ?? [],
    });
  }

  if (result?.prompt_id) {
    try {
      insertSnapshot({
        promptId: result.prompt_id,
        apiPromptJson: JSON.stringify(apiPrompt),
        templateName,
        triggered_by: 'ui',
        conversation_id: null,
        message_id: null,
      });
    } catch { /* snapshot failure must not fail the submit */ }

    const modelFingerprint = computeModelFingerprint(
      template?.models?.map(m =>
        typeof m === 'string' ? m : (m as { filename?: string }).filename ?? '',
      ).filter(Boolean) ?? [],
    );
    schedulePromptWatch(result.prompt_id, {
      triggeredBy: 'ui',
      conversationId: null,
      messageId: null,
      modelFingerprint,
      templateHash,
    });
  }

  // Wrap ComfyUI's response: rename prompt_id → promptId, add job URL helpers.
  const { prompt_id, ...rest } = result ?? {};
  const pid = prompt_id ?? '';
  const { statusUrl, streamUrl } = buildJobUrls(pid);
  return ok({ promptId: pid, statusUrl, streamUrl, ...rest });
});

// ---- Prompt-trigger mode override ----
//
// Walks every studioMode's `triggers` array, looking for the first one that
// appears in the prompt (case-insensitive substring). When found, returns
// the mode name + a cleaned prompt with the trigger substring (and the
// whitespace it leaves behind) removed.
//
// Stripping rules:
//   - Remove the trigger substring at its found position.
//   - Collapse the runs of whitespace adjacent to the cut so two spaces
//     don't become a visible gap.
//   - Trim leading/trailing whitespace from the final string.
function findTriggerHit(
  prompt: string,
  studioModes: Record<string, { triggers?: string[] }>,
): { mode: string; cleaned: string } | null {
  const lower = prompt.toLowerCase();
  let best: { mode: string; idx: number; len: number } | null = null;
  for (const [modeName, cfg] of Object.entries(studioModes)) {
    const triggers = cfg.triggers;
    if (!Array.isArray(triggers)) continue;
    for (const t of triggers) {
      if (typeof t !== 'string' || t.length === 0) continue;
      const idx = lower.indexOf(t.toLowerCase());
      if (idx === -1) continue;
      // Earliest hit wins. Ties broken by longest trigger (more specific).
      if (!best
          || idx < best.idx
          || (idx === best.idx && t.length > best.len)) {
        best = { mode: modeName, idx, len: t.length };
      }
    }
  }
  if (!best) return null;
  const before = prompt.slice(0, best.idx);
  const after = prompt.slice(best.idx + best.len);
  // Collapse one space if both sides surround the cut.
  const join = /\s$/.test(before) && /^\s/.test(after) ? '' : '';
  const cleaned = (before + join + after).replace(/\s{2,}/g, ' ').trim();
  return { mode: best.mode, cleaned };
}

// ---- Title-search toggle helper ----
//
// For every boolean key in `userInputs` that isn't already routed by an
// explicit `studioInputMap` entry, look inside the active mode's enable
// groups for a switch-shaped node whose title equals the key (case-
// insensitive). When found, mutate `widgets_values[0]` so the subsequent
// `workflowToApiPrompt` picks the value up via the normal conversion.
//
// Templates declare which keys the UI will send via `prompt_toggles`; this
// function is the server-side complement — it doesn't read prompt_toggles
// itself (no point — the UI is what gates which inputs exist in the
// payload), it just resolves whichever boolean keys do arrive.
function applyTitleToggleSwitches(
  workflow: unknown,
  mode: string,
  modeCfg: { enableGroups?: string[] },
  userInputs: Record<string, unknown>,
  renameMap: Record<string, string>,
): void {
  const wf = workflow as {
    nodes?: Array<{
      id: number;
      type?: string;
      title?: string;
      pos?: [number, number];
      size?: [number, number] | { 0: number; 1: number };
      widgets_values?: unknown[];
    }>;
    groups?: Array<{ title?: string; bounding?: [number, number, number, number] }>;
  };
  const nodes = wf.nodes;
  const groups = wf.groups;
  if (!Array.isArray(nodes) || !Array.isArray(groups)) return;

  // Resolve which groups are "active" for this mode. Empty match → fall
  // back to ANY group in the workflow so templates without explicit
  // enableGroups (or whose groups are unnamed) still get auto-routing.
  const enable = new Set(modeCfg.enableGroups ?? [mode]);
  let bounds = groups
    .filter(g => g.title && enable.has(g.title) && g.bounding && g.bounding.length === 4)
    .map(g => g.bounding as [number, number, number, number]);
  if (bounds.length === 0) {
    bounds = groups
      .filter(g => g.bounding && g.bounding.length === 4)
      .map(g => g.bounding as [number, number, number, number]);
  }

  for (const [key, value] of Object.entries(userInputs)) {
    if (typeof value !== 'boolean') continue;
    if (renameMap[key]) continue; // studioInputMap claimed this key

    const needle = key.toLowerCase();
    for (const node of nodes) {
      if (!node.title || node.title.toLowerCase() !== needle) continue;
      if (!(node.type ?? '').toLowerCase().includes('switch')) continue;
      if (!Array.isArray(node.pos) || node.pos.length < 2) continue;
      if (!inAnyBound(node, bounds)) continue;
      // Match. Write the boolean to the first widget slot. The conversion
      // step picks this up via the node's INPUT_TYPES mapping.
      if (!Array.isArray(node.widgets_values)) node.widgets_values = [];
      node.widgets_values[0] = value;
      break;
    }
  }
}

function inAnyBound(
  node: { pos?: [number, number]; size?: [number, number] | { 0: number; 1: number } },
  bounds: Array<[number, number, number, number]>,
): boolean {
  if (bounds.length === 0) return true;
  const [nx, ny] = node.pos as [number, number];
  const sizeArr: [number, number] | undefined = Array.isArray(node.size)
    ? node.size
    : (node.size ? [node.size[0], node.size[1]] : undefined);
  const nw = sizeArr?.[0] ?? 200;
  const nh = sizeArr?.[1] ?? 80;
  const cx = nx + nw / 2;
  const cy = ny + nh / 2;
  for (const [gx, gy, gw, gh] of bounds) {
    if (cx >= gx && cx <= gx + gw && cy >= gy && cy <= gy + gh) return true;
  }
  return false;
}

const router = Router();
router.use(generateLimiter);
generateRoute.register(router);

export default router;
