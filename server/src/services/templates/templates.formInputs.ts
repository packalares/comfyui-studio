// Generates the "form inputs" list shown in the Studio form for a given
// template. Two-stage pipeline:
//   1. Media-upload path (unchanged): `io.inputs` with mediaType image/audio/
//      video become upload fields on the declared node.
//   2. Prompt-surface walk: when a workflow is available, we emit ONE form
//      field per prompt-surface widget with an explicit (nodeId, widgetName)
//      binding — so multi-field encoders (TextEncodeAceStepAudio1.5 etc.)
//      surface separate "tags" and "lyrics" fields instead of collapsing to
//      one textarea that silently overwrites both widgets identically.
//   3. Tag-only fallback: templates without a workflow (upstream catalog)
//      keep the legacy unbound generic `prompt` textarea.

import { extractPrimitiveFormFields } from '../workflow/primitiveFields.js';
// Deep-import from shapes.ts, NOT the rawWidgets barrel — the barrel pulls
// in `claimed.ts` which imports from `../../templates/index.ts`, creating
// a cycle (templates → workflow → templates).
import { filteredWidgetValues, widgetNamesFor } from '../workflow/rawWidgets/shapes.js';
import { flattenWorkflow } from '../workflow/flatten/index.js';
import type { FormInputData, RawTemplate } from './types.js';

// Human labels for well-known prompt-surface widget names. Anything not in
// this map falls back to Title Case(widgetName).
const WIDGET_LABELS: Record<string, string> = {
  text: 'Prompt',
  prompt: 'Prompt',
  positive_prompt: 'Positive Prompt',
  negative_prompt: 'Negative Prompt',
  tags: 'Style Tags',
  lyrics: 'Lyrics',
  clip_l: 'CLIP-L',
  t5xxl: 'T5-XXL',
  text_g: 'Text (G)',
  text_l: 'Text (L)',
};

function titleCaseWidget(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function cleanFileName(file: string): string {
  return file
    .replace(/\.[^/.]+$/, '')
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

const PROMPT_TAG_TRIGGERS = new Set([
  'Text to Image', 'Text to Video', 'Text to Audio', 'Image Edit',
  'Image to Video', 'Text to Model', 'Text to Speech', 'Video Edit',
  'Style Transfer', 'Inpainting', 'Outpainting', 'Relight',
  'ControlNet', 'Image', 'Video', 'API',
]);

function defaultPromptField(description?: string): FormInputData {
  return {
    id: 'prompt',
    label: 'Prompt',
    type: 'textarea',
    required: true,
    description,
    placeholder: 'Describe what you want to generate...',
  };
}

/**
 * Walk `workflow.links` from the loader's output → find the downstream
 * node's input. Return true when the terminal input is marked optional
 * (`shape === 7` in LiteGraph's convention). `null` when we can't tell
 * — caller treats unknown as required (safe default).
 */
function loaderFeedsOptionalInput(
  workflow: Record<string, unknown> | undefined,
  loaderNodeId: number,
): boolean | null {
  if (!workflow) return null;
  const links = (workflow.links as unknown[] | undefined) ?? [];
  const nodes = (workflow.nodes as Array<Record<string, unknown>> | undefined) ?? [];
  // LiteGraph link shape: [id, originNodeId, originSlot, targetNodeId, targetSlot, type]
  for (const raw of links) {
    if (!Array.isArray(raw) || raw.length < 5) continue;
    const originNodeId = raw[1];
    if (originNodeId !== loaderNodeId) continue;
    const targetNodeId = raw[3] as number;
    const targetSlot = raw[4] as number;
    const target = nodes.find((n) => (n.id as number) === targetNodeId);
    const targetInputs = (target?.inputs as Array<Record<string, unknown>> | undefined) ?? [];
    const inp = targetInputs[targetSlot];
    if (inp && inp.shape === 7) return true;
  }
  return false;
}

function mediaInput(
  mediaType: 'image' | 'audio' | 'video',
  index: number,
  input: { nodeId: number; nodeType: string; file?: string; mediaType: string },
  workflow?: Record<string, unknown>,
): FormInputData {
  const defaultLabel = `${mediaType.charAt(0).toUpperCase()}${mediaType.slice(1)} ${index + 1}`;
  const isOptional = loaderFeedsOptionalInput(workflow, input.nodeId) === true;
  return {
    id: `${mediaType}_${index}`,
    label: input.file ? cleanFileName(input.file) : defaultLabel,
    type: mediaType,
    required: !isOptional,
    nodeId: input.nodeId,
    nodeType: input.nodeType,
    mediaType,
  };
}

// Is this objectInfo input spec a multiline STRING widget? Mirrors the rule
// in `rawWidgets/claimed.ts::collectPromptClaimedWidgets` so we only emit
// fields for widgets the claim-set would hide.
function isMultilineStringSpec(spec: unknown): boolean {
  if (!Array.isArray(spec) || spec[0] !== 'STRING') return false;
  return (spec[1] as { multiline?: boolean } | undefined)?.multiline === true;
}

// Emit one prompt-surface field per multiline STRING widget on the first
// non-negative node that has any. Stops at that node. Returns `null` when
// no such node exists OR no objectInfo for its class_type.
function promptSurfaceFieldsFromNodes(
  workflow: Record<string, unknown>,
  objectInfo: Record<string, Record<string, unknown>>,
): FormInputData[] | null {
  // Flatten first so CLIPTextEncode (or any encoder) nested inside a
  // subgraph wrapper surfaces as a bound form field. Compound IDs like
  // `98:6` from the flattener double as the `bindNodeId` the server's
  // `applyBoundFormInputs` already understands. Fall back to top-level
  // node iteration if flattening throws — preserves legacy behaviour for
  // non-subgraph / malformed workflows.
  let flatNodes: Array<Record<string, unknown>> | null = null;
  try {
    const flat = flattenWorkflow(workflow);
    flatNodes = Array.from(flat.nodes.values()) as unknown as Array<Record<string, unknown>>;
  } catch {
    flatNodes = null;
  }
  const nodes: Array<Record<string, unknown>> = flatNodes
    ?? ((workflow.nodes as Array<Record<string, unknown>> | undefined) || []);
  for (const node of nodes) {
    const classType = (node.type as string | undefined) || (node.class_type as string | undefined);
    if (!classType) continue;
    const title = (node.title as string | undefined) || '';
    if (/negative/i.test(title)) continue;
    const schema = objectInfo[classType] as {
      input?: {
        required?: Record<string, unknown>;
        optional?: Record<string, unknown>;
      };
    } | undefined;
    if (!schema?.input) continue;
    const declared = { ...(schema.input.required || {}), ...(schema.input.optional || {}) };
    const targets: string[] = [];
    for (const [name, spec] of Object.entries(declared)) {
      if (isMultilineStringSpec(spec)) targets.push(name);
    }
    if (targets.length === 0) continue;
    // Positional defaults — align widgetNamesFor with filteredWidgetValues
    // so 'fixed'/'randomize' tokens inserted by the UI don't shift indices.
    const widgetNames = widgetNamesFor(objectInfo, classType);
    const wv = filteredWidgetValues(node.widgets_values as unknown[] | undefined);
    const nodeId = String(node.id);
    const fields: FormInputData[] = [];
    for (const widgetName of targets) {
      const pos = widgetNames.indexOf(widgetName);
      const defaultRaw = pos >= 0 ? wv[pos] : undefined;
      const field: FormInputData = {
        id: widgetName,
        label: WIDGET_LABELS[widgetName] ?? titleCaseWidget(widgetName),
        type: 'textarea',
        required: true,
        bindNodeId: nodeId,
        bindWidgetName: widgetName,
      };
      if (typeof defaultRaw === 'string') field.default = defaultRaw;
      fields.push(field);
    }
    return fields;
  }
  return null;
}

/**
 * Build the form-input list. `objectInfo` is required to read widget specs;
 * caller-of-last-resort (upstream catalog where no workflow is available) can
 * pass an empty object — the function falls through to the tag-only prompt
 * fallback.
 *
 * Ordering in the output list:
 *   1. Media uploads (image / audio / video) — unchanged from legacy.
 *   2. Prompt-surface fields (primitive-derived first, then widget-walk).
 *   3. Tag-only fallback when neither produced a prompt-role field.
 */
export function generateFormInputs(
  template: RawTemplate,
  workflow?: Record<string, unknown>,
  objectInfo?: Record<string, Record<string, unknown>>,
): FormInputData[] {
  const inputs: FormInputData[] = [];

  // Prompt-surface walk — primitives first (subgraph-titled), then widget
  // walk. Dedupe on (bindNodeId, bindWidgetName): primitive entries win
  // because they carry the author's chosen title.
  let promptFields: FormInputData[] = [];
  if (workflow) {
    const primFields = extractPrimitiveFormFields(workflow);
    promptFields.push(...primFields);
    if (objectInfo) {
      const walked = promptSurfaceFieldsFromNodes(workflow, objectInfo) ?? [];
      const seen = new Set<string>();
      for (const f of promptFields) {
        if (f.bindNodeId && f.bindWidgetName) {
          seen.add(`${f.bindNodeId}|${f.bindWidgetName}`);
        }
      }
      for (const f of walked) {
        const key = `${f.bindNodeId}|${f.bindWidgetName}`;
        if (!seen.has(key)) promptFields.push(f);
      }
    }
  }

  const ioInputs = template.io?.inputs ?? [];
  const hasMedia = ioInputs.some(i =>
    i.mediaType === 'image' || i.mediaType === 'audio' || i.mediaType === 'video',
  );

  // Ordering matches pre-refactor behaviour for classic templates: prompt
  // field first, then media uploads. For workflows with no prompt-surface
  // nodes (no multiline STRING widgets, no titled Primitive), we fall back
  // to the legacy unbound generic prompt guarded by PROMPT_TAG_TRIGGERS.
  if (promptFields.length > 0) {
    inputs.push(...promptFields);
  } else {
    const needsPrompt = (template.tags?.some(t => PROMPT_TAG_TRIGGERS.has(t))) ?? false;
    // Emit default prompt when either: (a) no media uploads AND nothing else,
    // or (b) tag triggers call for one. Matches the old two-branch fallback.
    if (!hasMedia || needsPrompt) {
      inputs.push(defaultPromptField(template.description));
    }
  }

  for (let i = 0; i < ioInputs.length; i++) {
    const input = ioInputs[i];
    if (input.mediaType === 'image') inputs.push(mediaInput('image', i, input, workflow));
    else if (input.mediaType === 'audio') inputs.push(mediaInput('audio', i, input, workflow));
    else if (input.mediaType === 'video') inputs.push(mediaInput('video', i, input, workflow));
  }

  if (inputs.length === 0) {
    inputs.push(defaultPromptField());
  }
  return inputs;
}
