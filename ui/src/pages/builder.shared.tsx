// Shared bits used by Studio's Easy-mode builders (VideoBuilder, ImageBuilder,
// and later by Advanced for the same chip / dimension helpers).
//
// Everything here is pure / presentational — no API calls, no mutable state.
// Keep template-specific shape (STORAGE_KEY, INPUT_LABELS, PersistedForm) in
// the individual builders; only what's GENUINELY shared belongs here.

import type { ElementType } from 'react';
import {
  Square as SquareIcon, RectangleHorizontal, RectangleVertical,
  Image as ImageIcon, Film, Music, Sparkles, Wand2,
  X as XIcon,
} from 'lucide-react';
import {
  SelectField, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../components/forms/SelectField';
import { Tooltip, TooltipTrigger, TooltipContent } from '../components/ui/tooltip';
import type { MediaLibraryItem } from '../services/comfyui';
import {
  fetchEnhancerBundle, fetchEnhancerProfile,
} from '../lib/enhancer/profileClient';
import { buildEnhancerMessages } from '../lib/enhancer/buildPrompt';

// ---- Types ----

/** Payload Studio's footer reads to drive the bottom Generate / Reset
 *  buttons. Each builder publishes one via its `registerAction` prop. */
export interface EasyBuilderAction {
  onSubmit: () => void | Promise<void>;
  onReset: () => void;
  disabled: boolean;
  label: string;
}

/** Wider TemplateData fetched via /api/template-bundle/:name. Carries the
 *  Easy-mode metadata (studioModes + promptEnhancer) the server returns. */
export interface BuilderTemplateBundle {
  name: string;
  title?: string;
  studioModes?: Record<string, {
    requires?: string[];
    mute?: number[];
    switchNodeId?: number;
    switchSlot?: number;
    triggers?: string[];
    /** Per-mode resolution preset table for the Image tab. Each format id
     *  (1:1, 16:9, …) maps to a Standard + HD pixel pair. Picked up by
     *  `pickResolution` and rendered by ImageBuilder's chip row. */
    image_format?: Record<string, { standard: [number, number]; hd: [number, number] }>;
    /** Override used when the `faster` toggle is on AND the mode actually
     *  has a faster preset (e.g. t2i_flux_dev uses Flux 1 dev sizes when
     *  faster is on). Modes without this entry fall back to image_format. */
    image_format_faster?: Record<string, { standard: [number, number]; hd: [number, number] }>;
    /** Per-mode prompt-enhancer profile reference. When set, the Enhance
     *  button assembles the LLM system prompt from `data/enhancer/profiles/
     *  <profileId>.json` instead of using the template-level systemPrompt.
     *  Lets one template carry per-mode enhancer logic (e.g. t2i_flux_dev →
     *  flux2_prose, i2i_kontext1 → kontext_instruction). Unset = legacy
     *  template.promptEnhancer.systemPrompt path. */
    promptEnhancer?: {
      profileId: string;
      defaults?: {
        operation?: 'expand' | 'refine' | 'restyle' | 'enrich';
        length?: 'concise' | 'moderate' | 'detailed' | 'exhaustive';
        genre?: string;
      };
    };
  }>;
  promptEnhancer?: {
    systemPrompt: string;
    preferredModel?: string;
    options?: {
      num_ctx?: number;
      num_predict?: number;
      temperature?: number;
      top_p?: number;
      top_k?: number;
      min_p?: number;
      repeat_penalty?: number;
      presence_penalty?: number;
    };
    thinking?: boolean;
  };
  /** Per-mode UI toggles. Outer key is mode name OR `":"` (shared across all
   *  modes); inner is `{ key: tooltip-label }`. The UI renders one button per
   *  entry; the submit payload sends `inputs.<key>: <bool>`. */
  prompt_toggles?: Record<string, Record<string, string>>;
}

/** Resolve the active set of toggles for a given mode by merging the
 *  shared `":"` entry with the per-mode entry. Per-mode wins on key
 *  collision. Returns an ordered array so the UI renders deterministically. */
export function resolveToggles(
  prompt_toggles: BuilderTemplateBundle['prompt_toggles'],
  mode: string | null,
): Array<{ key: string; label: string }> {
  if (!prompt_toggles) return [];
  const merged: Record<string, string> = {
    ...(prompt_toggles[':'] ?? {}),
    ...(mode ? (prompt_toggles[mode] ?? {}) : {}),
  };
  return Object.entries(merged).map(([key, label]) => ({ key, label }));
}

// ---- Aspect ratio + sizing ----

/** Aspect-ratio presets shared by every builder. The chip row sources its
 *  options from here. */
export interface FormatOption {
  id: string;
  ratio: number;
  label: string;
  Icon: React.ElementType;
}

/** Image-builder catalog. The two extras over the video set — `3:2` /
 *  `2:3` — are still-photo formats that video models don't natively
 *  output, so they're omitted from VIDEO_FORMAT_OPTIONS below. */
export const FORMAT_OPTIONS: FormatOption[] = [
  { id: '1:1',  ratio: 1,        label: 'Square',             Icon: SquareIcon },
  { id: '21:9', ratio: 21 / 9,   label: 'Ultrawide',          Icon: RectangleHorizontal },
  { id: '16:9', ratio: 16 / 9,   label: 'Widescreen',         Icon: RectangleHorizontal },
  { id: '3:2',  ratio: 3 / 2,    label: 'Photo',              Icon: RectangleHorizontal },
  { id: '4:3',  ratio: 4 / 3,    label: 'Classic',            Icon: RectangleHorizontal },
  { id: '2:3',  ratio: 2 / 3,    label: 'Portrait photo',     Icon: RectangleVertical },
  { id: '3:4',  ratio: 3 / 4,    label: 'Traditional',        Icon: RectangleVertical },
  { id: '9:16', ratio: 9 / 16,   label: 'Social story',       Icon: RectangleVertical },
  { id: '9:21', ratio: 9 / 21,   label: 'Vertical ultrawide', Icon: RectangleVertical },
];

/** Video-builder catalog. Subset of FORMAT_OPTIONS sized for the ratios
 *  video models actually render at. If a video template declares its own
 *  `image_format` (or equivalent) in `studioModes`, `visibleFormatsForMode`
 *  intersects that table with this catalog so authoring the JSON narrows
 *  the chip row further from this baseline. */
export const VIDEO_FORMAT_OPTIONS: FormatOption[] = FORMAT_OPTIONS
  .filter((f) => ['1:1', '21:9', '16:9', '4:3', '3:4', '9:16', '9:21'].includes(f.id));

/** Filter a format catalog down to the ratios the active mode actually
 *  declares in its `image_format` table. Mode-less or empty-table callers
 *  fall back to the full catalog so the chip row never blanks out on
 *  templates without an `image_format` wired. Pass `FORMAT_OPTIONS` for
 *  image, `VIDEO_FORMAT_OPTIONS` for video; the same intersection logic
 *  applies on top of either, so once a video template eventually declares
 *  `image_format` it narrows down from the video catalog cleanly. */
export function visibleFormatsForMode(
  studioModes: BuilderTemplateBundle['studioModes'] | undefined,
  modeName: string | null | undefined,
  catalog: FormatOption[] = FORMAT_OPTIONS,
): FormatOption[] {
  if (!studioModes || !modeName) return catalog;
  const table = studioModes[modeName]?.image_format;
  if (!table) return catalog;
  return catalog.filter((f) => f.id in table);
}

/** Resolve a (format, qualityBase) pair into pixel dimensions. `qualityBase`
 *  is always the short side — landscape stretches width, portrait stretches
 *  height, square keeps both equal. */
export function dimsFor(formatId: string, qualityBase: number): { width: number; height: number } {
  const f = FORMAT_OPTIONS.find((x) => x.id === formatId) ?? FORMAT_OPTIONS[1];
  if (f.ratio === 1) return { width: qualityBase, height: qualityBase };
  if (f.ratio > 1) return { width: Math.round(qualityBase * f.ratio), height: qualityBase };
  return { width: qualityBase, height: Math.round(qualityBase / f.ratio) };
}

// ---- Media helpers ----

/** Build the GET URL that fetches a media-library item by filename + subfolder.
 *  Works for image previews directly; audio/video callers fall back to icons
 *  since the browser preview isn't useful. */
export function viewUrlFor(item: MediaLibraryItem): string {
  const qs = new URLSearchParams({
    filename: item.filename,
    subfolder: item.subfolder,
    type: 'input',
  });
  return `/api/view?${qs.toString()}`;
}

/** Blob → base64 WITHOUT the `data:...;base64,` prefix. Ollama's chat API
 *  wants the raw payload string only, so we strip the data-URL header. */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}

// ---- Prompt-enhancer shared call ----
//
// Single source of truth for the /api/llm/chat round trip used by both
// VideoBuilder and ImageBuilder. The mode-specific bit (which media items
// count as the LLM's image input) stays in each builder; this function
// just takes the already-encoded base64 strings and runs the streamed
// chat + JSON-aware response extraction.
//
// Output contract:
//   - Plain-text response  → result.prompt = trimmed raw text (today's behavior)
//   - JSON response with a `prompt` field → result.prompt = parsed.prompt,
//     other recognised fields surfaced for downstream UI to consume.
//   - Empty / thinking-only / error → caller decides how to message it
//     using `result.sawThinking` + `result.prompt`'s emptiness.

export interface EnhancedResult {
  /** Final image-prompt string to drop into the textarea. Empty when
   *  the model never finalised (thinking-only) or returned an error. */
  prompt: string;
  /** Optional fields surfaced from a JSON enhancer schema. Unused by
   *  today's builders; callers can wire them as state slots when ready. */
  negativePrompt?: string;
  recommendedSize?: { width: number; height: number };
  settings?: { steps?: number; guidance?: number };
  warnings?: string[];
  /** True iff any NDJSON frame had `message.thinking` content. Useful for
   *  surfacing "model ran out of num_predict budget on reasoning" toasts. */
  sawThinking: boolean;
  /** Raw accumulated content (pre-JSON-parse). Surface in error toasts /
   *  debug panels so the user can see what the LLM actually emitted. */
  raw: string;
}

export async function runEnhancePrompt(args: {
  prompt: string;
  images: string[];               // already base64-encoded; caller filters which refs to send
  bundle: BuilderTemplateBundle;
  /** Active studio mode (e.g. `t2i_flux_dev`, `i2i_kontext1`). Optional for
   *  back-compat — when present and the mode has a `promptEnhancer.profileId`
   *  set, runEnhancePrompt routes through the profile library (data-driven,
   *  per-mode) instead of the legacy template-level systemPrompt path. */
  mode?: string | null;
}): Promise<EnhancedResult> {
  // ---- Path A — profile-driven enhancer (data-driven, per-mode) -----
  //
  // Studio mode JSON carries a `promptEnhancer.profileId` pointing at one of
  // the bundled profiles under `server/data/enhancer/profiles/`. Fetch the
  // profile + the master/genres/operations bundle, assemble the system
  // prompt via `buildEnhancerMessages`, and skip the legacy path entirely.
  // Falls back to Path B when ANY step fails (network error, missing
  // profile, bundle unavailable) so a misconfigured profileId never breaks
  // Enhance.
  const modeEnh = args.mode
    ? args.bundle.studioModes?.[args.mode]?.promptEnhancer
    : undefined;
  if (modeEnh?.profileId) {
    try {
      const [profile, enhBundle] = await Promise.all([
        fetchEnhancerProfile(modeEnh.profileId),
        fetchEnhancerBundle(),
      ]);
      if (profile && enhBundle) {
        const built = buildEnhancerMessages({
          profile,
          bundle: enhBundle,
          rawIdea: args.prompt,
          targetMode: args.mode!,
          operation: modeEnh.defaults?.operation,
          length: modeEnh.defaults?.length as
            | 'concise' | 'moderate' | 'detailed' | 'exhaustive' | undefined,
          genre: modeEnh.defaults?.genre,
          sourceImageCount: args.images.length,
        });
        return runChatStream({
          model: built.preferredModel,
          messages: built.messages,
          options: {
            num_ctx: 8192,
            num_predict: built.options.num_predict,
            temperature: built.options.temperature,
            top_p: built.options.top_p,
            top_k: 64,
            min_p: 0.05,
            repeat_penalty: 1.05,
            presence_penalty: 0.0,
          },
          images: args.images,
          thinking: false,
        });
      }
      // Fall through to legacy path when profile/bundle fetch failed.
    } catch {
      // Same fallback on any unexpected error — never block Enhance.
    }
  }

  // ---- Path B — legacy template-level systemPrompt -----------------

  const enhancer = args.bundle.promptEnhancer;
  if (!enhancer?.systemPrompt) {
    throw new Error('This model has no prompt enhancer configured');
  }

  const model = enhancer.preferredModel ?? 'qwen2.5:7b';
  const system = enhancer.systemPrompt;

  // Template-tunable Ollama options merged with sane UI defaults — same
  // values both builders shipped with so behaviour for existing templates
  // is unchanged.
  const tplOpts = enhancer.options ?? {};
  const options = {
    num_ctx: tplOpts.num_ctx ?? 8192,
    num_predict: tplOpts.num_predict ?? 1024,
    temperature: tplOpts.temperature ?? 0.4,
    top_p: tplOpts.top_p ?? 0.9,
    top_k: tplOpts.top_k ?? 64,
    min_p: tplOpts.min_p ?? 0.05,
    repeat_penalty: tplOpts.repeat_penalty ?? 1.05,
    presence_penalty: tplOpts.presence_penalty ?? 0.0,
  };

  return runChatStream({
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: args.prompt }],
    options,
    images: args.images,
    thinking: enhancer.thinking === true,
  });
}

// ---- /api/llm/chat round trip + NDJSON parse ----
//
// Extracted from runEnhancePrompt so both profile-driven (Path A) and
// legacy (Path B) paths share one streaming + JSON-aware response handler.
// Behaviour identical to the pre-refactor inline code — same body shape,
// same NDJSON loop, same tryParseEnhancerJson fallback.
async function runChatStream(args: {
  model: string;
  messages: Array<{ role: 'system' | 'user'; content: string }>;
  options: Record<string, number>;
  images: string[];
  thinking: boolean;
}): Promise<EnhancedResult> {
  // Append the images array to the LAST user message — Ollama's `images`
  // field is per-message, attached alongside the role:'user' content.
  const messages: Array<Record<string, unknown>> = args.messages.map((m) => ({ ...m }));
  if (args.images.length > 0) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'user') {
        messages[i].images = args.images;
        break;
      }
    }
  }

  // `thinking` is a top-level Ollama chat field, NOT a sampling option.
  // Forwarded only when the caller opts in (default off).
  //
  // `stream: true` is critical: without streaming, large-context thinking
  // models can take 60-120s to produce, and nginx-ingress's default 60s
  // proxy_read_timeout would return 504 before Studio saw the answer.
  const body: Record<string, unknown> = {
    model: args.model,
    stream: true,
    messages,
    options: args.options,
  };
  if (args.thinking) body.thinking = true;

  const res = await fetch('/api/llm/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `LLM chat failed (${res.status})`);
  }

  // Parse NDJSON: one JSON frame per line, accumulate `message.content`
  // deltas. Tally `message.thinking` separately so callers can warn when
  // the model spent its entire budget reasoning without producing answer.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let sawThinking = false;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let frame: { message?: { content?: string; thinking?: string }; error?: string };
      try { frame = JSON.parse(line); } catch { continue; }
      if (frame.error) throw new Error(frame.error);
      if (frame.message?.content) content += frame.message.content;
      if (frame.message?.thinking) sawThinking = true;
    }
  }

  const accumulated = content.trim();

  // JSON-aware extraction. Templates that opt into a structured output
  // schema return a JSON object with at least a `prompt` field; we route
  // its known keys into the typed result. Anything else — plain text,
  // un-parseable JSON, JSON without `prompt` — falls back to the raw
  // accumulated string, preserving today's behaviour.
  const structured = tryParseEnhancerJson(accumulated);
  if (structured && typeof structured.prompt === 'string') {
    const result: EnhancedResult = {
      prompt: structured.prompt.trim(),
      sawThinking,
      raw: accumulated,
    };
    if (typeof structured.negative_prompt === 'string') {
      result.negativePrompt = structured.negative_prompt;
    }
    if (typeof structured.recommended_size === 'string') {
      const parsed = parseSizeString(structured.recommended_size);
      if (parsed) result.recommendedSize = parsed;
    }
    if (structured.settings && typeof structured.settings === 'object') {
      const s = structured.settings as Record<string, unknown>;
      const stepsNum = typeof s.steps === 'string'
        ? parseInt(s.steps, 10)
        : typeof s.steps === 'number' ? s.steps : undefined;
      const guidNum = typeof s.guidance === 'string'
        ? parseFloat(s.guidance)
        : typeof s.guidance === 'number' ? s.guidance : undefined;
      const settings: { steps?: number; guidance?: number } = {};
      if (typeof stepsNum === 'number' && !Number.isNaN(stepsNum)) settings.steps = stepsNum;
      if (typeof guidNum === 'number' && !Number.isNaN(guidNum)) settings.guidance = guidNum;
      if (Object.keys(settings).length > 0) result.settings = settings;
    }
    if (Array.isArray(structured.warnings)) {
      result.warnings = structured.warnings.filter((w): w is string => typeof w === 'string');
    }
    return result;
  }

  // Plain-text fallback — identical to pre-refactor behaviour.
  return { prompt: accumulated, sawThinking, raw: accumulated };
}

/** Tolerantly find the JSON object in the LLM's response. Strict `JSON.parse`
 *  first; if that fails (preamble like "Here is the JSON:\n{...}") fall back
 *  to extracting the outermost `{...}` span. Returns null when no plausible
 *  object is present — caller treats output as plain text. */
function tryParseEnhancerJson(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  const candidates = start === 0 && end === raw.length - 1
    ? [raw]
    : [raw, raw.slice(start, end + 1)];
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch { /* try the next candidate */ }
  }
  return null;
}

/** Build the JSON the Image tab sends to its prompt enhancer as the LLM
 *  user-message content. Pass-through of what the UI already has — no
 *  mapping tables, no invented fields. The template's system prompt teaches
 *  the LLM the studioMode-name convention (e.g. `t2i_flux_dev` → task
 *  text-to-image, model FLUX.1 dev). New modes just work without code
 *  changes: split on `_`, the LLM picks the rule set.
 *
 *  Only fields with real data are emitted; empty camera_details or zero
 *  reference_count are dropped so the LLM doesn't waste budget on noise. */
export function buildImageEnhancerInput(args: {
  prompt: string;
  inferredMode: string;          // → target_model verbatim
  formatId: string;              // → aspect_ratio (FORMAT_OPTIONS ids are already "W:H")
  referenceCount: number;
  cameraLabels?: {
    camera?: string | null;
    lens?: string | null;
    aperture?: string | null;
    focalLength?: string | null;
  } | null;
}): string {
  const payload: Record<string, unknown> = {
    target_model: args.inferredMode,
    raw_idea: args.prompt.trim(),
    aspect_ratio: args.formatId,
  };
  if (args.referenceCount > 0) {
    payload.source_image_count = args.referenceCount;
  }
  if (args.cameraLabels) {
    const cd: Record<string, string> = {};
    if (args.cameraLabels.lens)     cd.lens = args.cameraLabels.lens;
    if (args.cameraLabels.aperture) cd.aperture = args.cameraLabels.aperture;
    if (args.cameraLabels.camera)   cd.film_or_sensor = args.cameraLabels.camera;
    if (Object.keys(cd).length > 0) payload.camera_details = cd;
  }
  return JSON.stringify(payload);
}

// ---- Image mode + resolution helpers ----

/** Quality tiers used by the Image tab's Quality chip. */
export type QualityTier = 'standard' | 'hd';

/** A single mode option as surfaced in the Model chip row.
 *  `name` is the studioMode key (e.g. `t2i_flux_dev`), `label` is the
 *  human-friendly title, `trigger` is the first `@…` shortcut if any. */
export interface ModeGroupEntry {
  name: string;
  label: string;
  trigger?: string;
}

/** Group all studioModes by their task-type prefix (the first underscore
 *  segment of the mode name). Today only `t2i` exists in image templates;
 *  the grouping is forward-compatible with future `i2i`, `i2v`, `t2v`. */
export function groupModesByTaskType(
  studioModes: BuilderTemplateBundle['studioModes'],
): Array<{ taskType: string; modes: ModeGroupEntry[] }> {
  if (!studioModes) return [];
  const groups: Record<string, ModeGroupEntry[]> = {};
  for (const [name, cfg] of Object.entries(studioModes)) {
    const segs = name.split('_');
    const taskType = segs[0] || 'other';
    const modelPart = segs.slice(1).join('_');
    const label = humanizeModelName(modelPart);
    const trigger = cfg.triggers?.[0];
    (groups[taskType] ??= []).push({ name, label, trigger });
  }
  return Object.entries(groups).map(([taskType, modes]) => ({ taskType, modes }));
}

/** Turn a snake_case model part into a Title-Case label.
 *  `flux_dev`      → "Flux Dev"
 *  `flux_klein_9b` → "Flux Klein 9B"
 *  `qwen_2512`     → "Qwen 2512"
 *  Numeric segments stay numeric (or get .toUpperCase() so "9b" → "9B"). */
function humanizeModelName(s: string): string {
  if (!s) return '(default)';
  return s.split('_').map((p) => {
    if (!p) return '';
    if (/^\d/.test(p)) return p.toUpperCase();
    return p[0].toUpperCase() + p.slice(1);
  }).filter(Boolean).join(' ');
}

/** Resolve concrete pixel dimensions for a (mode, formatId, qualityId,
 *  toggles) tuple. Uses the mode's `image_format` (or `image_format_faster`
 *  when the `faster` toggle is on AND the mode declared an override).
 *  Falls back to 1024×1024 when anything is missing — the chip rows render
 *  even on templates that never wired the preset table, so the UI never
 *  blanks out. */
export function pickResolution(args: {
  mode: string;
  formatId: string;
  qualityId: QualityTier;
  toggles: Record<string, boolean>;
  studioModes: BuilderTemplateBundle['studioModes'];
}): { width: number; height: number } {
  const fallback = { width: 1024, height: 1024 };
  const cfg = args.studioModes?.[args.mode];
  if (!cfg) return fallback;
  const table = (args.toggles.faster && cfg.image_format_faster)
    ? cfg.image_format_faster
    : cfg.image_format;
  if (!table) return fallback;
  const fmt = table[args.formatId] ?? table['1:1'];
  if (!fmt) return fallback;
  const dims = fmt[args.qualityId] ?? fmt.standard;
  if (!dims) return fallback;
  return { width: dims[0], height: dims[1] };
}

/** Parse a "WxH" or "W×H" size string into numbers. Tolerates whitespace. */
function parseSizeString(s: string): { width: number; height: number } | null {
  const m = s.trim().match(/^(\d+)\s*[x×]\s*(\d+)$/i);
  if (!m) return null;
  const width = parseInt(m[1], 10);
  const height = parseInt(m[2], 10);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  return { width, height };
}

// ---- Mode inference + validation hints ----

/** Identify the mode whose `requires` set is EXACTLY the filled set. We
 *  deliberately do not fall back to a "best superset" — that used to silently
 *  downgrade richer payloads to a leaner mode and discard inputs the user
 *  had filled. Returns null when nothing matches. */
export function inferMode(
  filled: Set<string>,
  studioModes: BuilderTemplateBundle['studioModes'],
): string | null {
  if (!studioModes) return null;
  for (const [name, cfg] of Object.entries(studioModes)) {
    const req = new Set(cfg.requires ?? []);
    if (req.size === filled.size && [...req].every((r) => filled.has(r))) {
      return name;
    }
  }
  return null;
}

export function describeRequires(req: string[] | undefined, labels: Record<string, string>): string {
  if (!req || req.length === 0) return 'No inputs';
  return req.map((k) => labels[k] ?? k).join(' + ');
}

function labelKeys(keys: string[], labels: Record<string, string>): string {
  return keys.map((k) => labels[k] ?? k).join(' + ');
}

/** Up to two "do X to reach Y" suggestions, ranked by smallest diff. */
export function nearestModeHints(
  filled: Set<string>,
  studioModes: BuilderTemplateBundle['studioModes'],
  labels: Record<string, string>,
): string[] {
  if (!studioModes) return [];
  const ranked = Object.values(studioModes)
    .map((cfg) => {
      const req = cfg.requires ?? [];
      const reqSet = new Set(req);
      const missing = req.filter((r) => !filled.has(r));
      const extra = [...filled].filter((f) => !reqSet.has(f));
      return { req, missing, extra, diff: missing.length + extra.length };
    })
    .filter((s) => s.diff > 0)
    .sort((a, b) => a.diff - b.diff)
    .slice(0, 2);
  return ranked.map((s) => {
    const actions: string[] = [];
    if (s.missing.length) actions.push(`add ${labelKeys(s.missing, labels)}`);
    if (s.extra.length) actions.push(`drop ${labelKeys(s.extra, labels)}`);
    return `${actions.join(', ')} → ${describeRequires(s.req, labels)}`;
  });
}

// ---- Add-media pill ----
//
// Horizontal capsule with circular icon buttons, one per media kind. Each
// builder configures which slots are active / disabled / wired up — the
// component itself stays stateless. VideoBuilder enables `audio`, disables
// the rest; ImageBuilder enables `image`, disables the rest. Same visual
// shape across both, so the muscle memory carries over.

export type MediaKind = 'image' | 'video' | 'audio' | 'character' | 'effect';

const MEDIA_PILL_ICONS: Record<MediaKind, React.ElementType> = {
  image:     ImageIcon,
  video:     Film,
  audio:     Music,
  character: Sparkles,
  effect:    Wand2,
};

export interface MediaPillSlot {
  kind: MediaKind;
  /** Show the active-state styling (e.g. when the slot already has a pick). */
  active?: boolean;
  /** Render the button but make it non-interactive (a placeholder). */
  disabled?: boolean;
  /** Tooltip text. Falls back to no tooltip if omitted. */
  tooltip?: string;
  /** Click handler. Only fired when not disabled. */
  onClick?: () => void;
}

function MediaPillButton({
  icon: Icon, tooltip, disabled, active, onClick,
}: {
  icon: React.ElementType;
  tooltip?: string;
  disabled?: boolean;
  active?: boolean;
  onClick?: () => void;
}) {
  const cls = `inline-flex h-7 w-7 items-center justify-center rounded-full transition-colors ${
    active
      ? 'bg-brand text-brand-foreground'
      : disabled
        ? 'bg-background/60 text-muted-foreground/60 cursor-not-allowed'
        : 'bg-background text-muted-foreground hover:bg-background/80 hover:text-foreground'
  }`;
  const btn = (
    <button type="button" disabled={disabled} onClick={onClick} className={cls}>
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
  if (!tooltip) return btn;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{btn}</TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

export function AddMediaPill({ slots }: { slots: MediaPillSlot[] }) {
  return (
    <div className="mt-3 flex items-center gap-2 rounded-full bg-muted px-2 py-1.5">
      <div className="flex items-center gap-1">
        {slots.map((s) => (
          <MediaPillButton
            key={s.kind}
            icon={MEDIA_PILL_ICONS[s.kind]}
            tooltip={s.tooltip}
            disabled={s.disabled}
            active={s.active}
            onClick={s.onClick}
          />
        ))}
      </div>
      <span className="text-xs text-muted-foreground">Add media</span>
    </div>
  );
}

// Big labeled reference slot. When empty: filled-grey card with icon + label.
// When picked: image preview with corner X to clear and a gradient label
// overlay. Used by VideoBuilder (Start/End image) and ImageBuilder (Main image).
export function RefSlot({
  icon: Icon, label, item, onOpen, onClear,
}: {
  icon: ElementType;
  label: string;
  item: MediaLibraryItem | null;
  onOpen: () => void;
  onClear: () => void;
}) {
  if (item) {
    const isImage = item.kind === 'image';
    return (
      <button
        type="button"
        onClick={onOpen}
        className="group relative aspect-[2/1] w-full overflow-hidden rounded-lg border bg-card shadow-sm text-left"
        title={`Change ${label} (current: ${item.filename})`}
      >
        {isImage ? (
          // `object-contain` keeps the full image visible inside the
          // RefSlot tile — portrait inputs no longer get top/bottom
          // cropped by the 2:1 wrapper. The empty side strips are
          // intentional, mirrors the output viewer's letterbox behaviour.
          <img src={viewUrlFor(item)} alt={item.filename} className="h-full w-full object-contain bg-muted" />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-muted text-muted-foreground">
            <Icon className="h-5 w-5" />
          </div>
        )}
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => { e.stopPropagation(); onClear(); }}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClear(); } }}
          className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-background/85 text-foreground shadow ring-1 ring-border opacity-0 transition-opacity group-hover:opacity-100"
          aria-label={`Remove ${label}`}
        >
          <XIcon className="h-3 w-3" />
        </span>
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-foreground/70 to-transparent px-2 py-1">
          <p className="truncate text-[10px] font-medium text-background">{label}</p>
        </div>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex aspect-[2/1] w-full cursor-pointer flex-col items-start justify-between rounded-lg bg-muted p-2.5 text-left transition-colors hover:bg-muted/80"
    >
      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-background/80 text-muted-foreground group-hover:bg-background">
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="text-[13px] font-medium text-foreground">{label}</span>
    </button>
  );
}

// @-mention picker and `renderHighlightedPrompt` overlay used to live here.
// Both belonged to the old textarea + transparent-mirror pattern. They were
// retired when ImageBuilder/VideoBuilder switched to PromptComposer, which
// renders the picker and chip overlays natively in its contentEditable. If
// you need to bring mention picking back to a textarea-based field, lift
// it from the PromptComposer's `getTextBeforeCaret` / commit-mention logic
// rather than reviving the old hook.

// ---- Toggles row ----
//
// A row of Sparkles icon buttons inside the Prompt card footer, one per
// declared toggle. Same visual idiom as the old static `autoEnhance`
// button, but driven by the template's `prompt_toggles` metadata so
// VideoBuilder and ImageBuilder both render whatever the active template
// declares (and nothing when no toggles are declared).
//
// State is owned by the caller — `values` is `{ key: bool }`, `onChange`
// fires with the next state when the user clicks a button.

import {
  Zap, Gauge, Maximize2, Lightbulb, Palette,
  ShieldCheck, Wand2 as WandIcon,
} from 'lucide-react';
import { Tooltip as TgTooltip, TooltipTrigger as TgTrigger, TooltipContent as TgContent } from '../components/ui/tooltip';

// Keyword → icon dictionary. The toggle's key (case-insensitive) is matched
// against the entries below; the FIRST keyword found anywhere in the key
// wins. Unknown keys fall back to Sparkles. Keep the list short and ordered
// from most-specific to most-general; substring match means `lightning_fast`
// matches `lightning` before `fast`.
const TOGGLE_ICON_MAP: Array<{ keywords: string[]; Icon: React.ElementType }> = [
  { keywords: ['faster', 'fast', 'quick', 'speed', 'lightning', 'turbo'], Icon: Zap },
  { keywords: ['hd', 'hi-res', 'hires', 'upscale', 'resolution'],          Icon: Maximize2 },
  { keywords: ['quality', 'detail', 'detailed', 'fidelity'],               Icon: Gauge },
  { keywords: ['style', 'creative', 'aesthetic'],                          Icon: Palette },
  { keywords: ['idea', 'inspire', 'creative_mode'],                        Icon: Lightbulb },
  { keywords: ['safe', 'safety', 'filter'],                                Icon: ShieldCheck },
  { keywords: ['enhance', 'magic'],                                        Icon: Sparkles },
  { keywords: ['rewrite', 'rephrase'],                                     Icon: WandIcon },
];

function iconForToggleKey(key: string): React.ElementType {
  const k = key.toLowerCase();
  for (const { keywords, Icon } of TOGGLE_ICON_MAP) {
    if (keywords.some((kw) => k.includes(kw))) return Icon;
  }
  return Sparkles;
}

export function TogglesRow({
  toggles,
  values,
  onChange,
}: {
  toggles: Array<{ key: string; label: string }>;
  values: Record<string, boolean>;
  onChange: (next: Record<string, boolean>) => void;
}) {
  if (toggles.length === 0) return null;
  return (
    <>
      {toggles.map(({ key, label }) => {
        const on = !!values[key];
        const Icon = iconForToggleKey(key);
        return (
          <TgTooltip key={key}>
            <TgTrigger asChild>
              <button
                type="button"
                aria-pressed={on}
                onClick={() => onChange({ ...values, [key]: !on })}
                className={
                  'inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors ' +
                  (on
                    ? 'bg-brand/15 text-brand hover:bg-brand/20'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground')
                }
              >
                <Icon className="w-3.5 h-3.5" />
              </button>
            </TgTrigger>
            <TgContent>{on ? `${label} (on)` : `${label} (off)`}</TgContent>
          </TgTooltip>
        );
      })}
    </>
  );
}

// ---- Chip select ----
//
// A compact chip-shaped select used in every builder's chip row (Duration ·
// Format · Resolution). Hides the lucide chevron, swaps in a builder-supplied
// leading icon, and supports an optional `trailing` slot (e.g. a tooltip
// info icon) that's stop-propagation-wrapped so it doesn't open the select.

export function ChipSelect({
  icon: Icon,
  value,
  options,
  selectedId,
  onChange,
  trailing,
  disabled,
}: {
  icon: React.ElementType;
  value: string;
  options: Array<{ id: string; left: string; right: string; Icon?: React.ElementType }>;
  selectedId: string;
  onChange: (id: string) => void;
  trailing?: React.ReactNode;
  /** When true, the trigger is non-interactive and styled muted. Used by
   *  preset-applied locks (e.g. `allow_user_select_aspect_ratio: false`)
   *  to keep the chip visible while preventing the user from changing it. */
  disabled?: boolean;
}) {
  return (
    <SelectField value={selectedId} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger
        className={[
          'h-8 w-auto gap-1.5 rounded-md border-0 bg-muted px-3 py-0 text-xs font-medium text-foreground shadow-none focus:outline-none focus-visible:outline-none focus:ring-0 focus-visible:ring-0 [&_svg.lucide-chevron-down]:hidden',
          disabled ? 'opacity-60 cursor-not-allowed' : 'hover:bg-muted/80',
        ].join(' ')}
      >
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        <SelectValue>{value}</SelectValue>
        {trailing && (
          <span
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center"
          >
            {trailing}
          </span>
        )}
      </SelectTrigger>
      <SelectContent>
        {options.map((opt) => {
          const RowIcon = opt.Icon;
          return (
            <SelectItem key={opt.id} value={opt.id} className="py-2">
              <span className="flex w-full min-w-[160px] items-center gap-3">
                {RowIcon && <RowIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
                <span className="font-medium tabular-nums">{opt.left}</span>
                <span className="ml-auto text-xs text-muted-foreground">{opt.right}</span>
              </span>
            </SelectItem>
          );
        })}
      </SelectContent>
    </SelectField>
  );
}

// ---- Shared builder hooks ----
//
// These hooks compress logic that was previously copy-pasted between
// ImageBuilder and VideoBuilder: the template filter, URL deep-link
// selection, per-template bundle fetch, dependency-check fetch, and
// debounced localStorage persistence. Each hook is small and has no
// builder-specific knowledge — only what's truly shared.

import {
  useEffect as useEffectBuilder,
  useMemo as useMemoBuilder,
  useState as useStateBuilder,
} from 'react';
import { toast as toastBuilder } from 'sonner';
import { useSearchParams as useSearchParamsBuilder } from 'react-router-dom';
import { api as apiBuilder } from '../services/comfyui';
import type { TemplateSummary as TemplateSummaryBuilder } from '../types';

/** Filter the global template list down to a builder's own pool by the
 *  metadata `studioBuilder` flag. */
export function useBuilderTemplates(
  templates: TemplateSummaryBuilder[],
  kind: 'image' | 'video',
): TemplateSummaryBuilder[] {
  return useMemoBuilder(
    () => templates.filter((t) => {
      const tx = t as TemplateSummaryBuilder & { studioBuilder?: string };
      return tx.studioBuilder === kind;
    }),
    [templates, kind],
  );
}

/** Owns the `selectedName` template selection, including:
 *   - seeding from a `?template=` URL param (TemplateCard deep-link),
 *   - falling back to a persisted last-used name, then first available,
 *   - clearing the URL param once consumed so a later in-tab change
 *     isn't undone by a back-nav,
 *   - re-picking the first template when the list arrives empty-then-full.
 *  Returns the standard `[value, setter]` tuple. */
export function useTemplateSelection(
  builderTemplates: TemplateSummaryBuilder[],
  persistedName: string | undefined,
): [string, (next: string) => void] {
  const [searchParams, setSearchParams] = useSearchParamsBuilder();
  const urlTemplate = searchParams.get('template') || '';
  const [selectedName, setSelectedName] = useStateBuilder<string>(() => {
    if (urlTemplate && builderTemplates.some((t) => t.name === urlTemplate)) return urlTemplate;
    if (persistedName && builderTemplates.some((t) => t.name === persistedName)) return persistedName;
    return builderTemplates[0]?.name ?? '';
  });
  useEffectBuilder(() => {
    if (!selectedName && builderTemplates.length > 0) setSelectedName(builderTemplates[0].name);
  }, [selectedName, builderTemplates]);
  useEffectBuilder(() => {
    if (!urlTemplate) return;
    if (!builderTemplates.some((t) => t.name === urlTemplate)) return;
    if (selectedName !== urlTemplate) setSelectedName(urlTemplate);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('template');
      return next;
    }, { replace: true });
  }, [urlTemplate, builderTemplates, selectedName, setSearchParams]);
  return [selectedName, setSelectedName];
}

/** Fetch the per-template builder bundle (studioModes + promptEnhancer +
 *  prompt_toggles) whenever `selectedName` changes. Returns the parsed
 *  bundle (or null when the template has no Easy-mode metadata) and a
 *  loading flag the caller can use to gate UI. */
export function useTemplateBundle(selectedName: string): {
  bundle: BuilderTemplateBundle | null;
  loading: boolean;
} {
  const [bundle, setBundle] = useStateBuilder<BuilderTemplateBundle | null>(null);
  const [loading, setLoading] = useStateBuilder(false);
  useEffectBuilder(() => {
    if (!selectedName) { setBundle(null); return; }
    let cancelled = false;
    setLoading(true);
    apiBuilder.getTemplateBundle(selectedName)
      .then((res) => {
        if (cancelled) return;
        const meta = res.builderMeta;
        setBundle(meta ? {
          name: selectedName,
          title: meta.title,
          studioModes: meta.studioModes,
          promptEnhancer: meta.promptEnhancer,
          prompt_toggles: meta.prompt_toggles,
        } : null);
      })
      .catch(() => { if (!cancelled) setBundle(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [selectedName]);
  return { bundle, loading };
}

/** Dependency-check fetch keyed off `selectedName`. Mirrors the bundle
 *  fetch shape — same cancel guard, same loading flag, missing models
 *  surface to the caller via the `check.missing` array. */
export interface DependencyCheck {
  ready: boolean;
  missing: Array<{ kind?: string; name?: string; filename?: string }>;
}
export function useDependencyCheck(selectedName: string): {
  check: DependencyCheck | null;
  loading: boolean;
} {
  const [check, setCheck] = useStateBuilder<DependencyCheck | null>(null);
  const [loading, setLoading] = useStateBuilder(false);
  useEffectBuilder(() => {
    if (!selectedName) { setCheck(null); return; }
    let cancelled = false;
    setLoading(true);
    setCheck(null);
    apiBuilder.checkDependencies(selectedName)
      .then((res) => { if (!cancelled) setCheck(res); })
      // Soft-fail to "ready" so the builder doesn't get stuck if the dep
      // endpoint is down — generation will surface real errors anyway.
      .catch(() => { if (!cancelled) setCheck({ ready: true, missing: [] }); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [selectedName]);
  return { check, loading };
}

/** Debounced localStorage write. Pass the JSON-serialisable blob; the
 *  hook serialises on a trailing-edge timer so rapid form-state churn
 *  collapses to a single write. */
export function useDebouncedPersist<T>(key: string, blob: T, delayMs = 300): void {
  useEffectBuilder(() => {
    const t = setTimeout(() => {
      try { localStorage.setItem(key, JSON.stringify(blob)); }
      catch { /* quota / serialise — best-effort */ }
    }, delayMs);
    return () => clearTimeout(t);
  }, [key, blob, delayMs]);
}

/** Apply a right-panel preset payload to one or more form fields when the
 *  payload's identity changes. Each handler is optional and only fires when
 *  the corresponding setting is a usable string; the toast fires once per
 *  preset apply if any field was touched. Studio passes a fresh payload
 *  object on every click, so re-applying the same preset twice still fires. */
export interface PresetApplyHandlers {
  setPrompt?: (next: string) => void;
  /** Sets the aspect-ratio chip. Only fires when the preset's
   *  `aspect_ratio` is a known FORMAT_OPTIONS id; `auto` and unknown
   *  values are skipped so the user's pick stays in effect. */
  setFormatId?: (next: string) => void;
  /** Sets the active template mode. Preset's `generation_mode` is the
   *  Pikaso-side key (e.g. `t2i_flux_dev`); the builder's mode-auto-pick
   *  effect coerces to a fallback if this template doesn't expose it. */
  setSelectedMode?: (next: string) => void;
  /** Locks the aspect-ratio chip from user changes when the preset
   *  declares `allow_user_select_aspect_ratio: false`. Called with `true`
   *  to lock and `false` to unlock — every preset apply resets the flag
   *  so a later preset that omits the field releases the lock. */
  setAspectLocked?: (locked: boolean) => void;
}
export function usePresetApply(
  presetApply: { id: string; card?: { id: string; title: string } | null; settings: Record<string, unknown> } | null | undefined,
  handlers: PresetApplyHandlers,
): void {
  useEffectBuilder(() => {
    if (!presetApply) return;
    const s = presetApply.settings as {
      prompt?: unknown;
      aspect_ratio?: unknown;
      generation_mode?: unknown;
      allow_user_select_aspect_ratio?: unknown;
    };
    let touched = false;
    if (handlers.setPrompt && typeof s.prompt === 'string' && s.prompt.length > 0) {
      handlers.setPrompt(s.prompt);
      touched = true;
    }
    if (handlers.setFormatId
      && typeof s.aspect_ratio === 'string'
      && FORMAT_OPTIONS.some((f) => f.id === s.aspect_ratio)
    ) {
      handlers.setFormatId(s.aspect_ratio);
      touched = true;
    }
    if (handlers.setSelectedMode
      && typeof s.generation_mode === 'string'
      && s.generation_mode.length > 0
    ) {
      handlers.setSelectedMode(s.generation_mode);
      touched = true;
    }
    if (handlers.setAspectLocked) {
      // Explicitly reset on every apply so omitting the field unlocks.
      handlers.setAspectLocked(s.allow_user_select_aspect_ratio === false);
    }
    if (touched) toastBuilder.success(`Applied preset: ${presetApply.card?.title ?? presetApply.id}`);
    // We deliberately don't depend on the individual handlers — they're
    // identity-unstable in the parent and would re-run the effect on every
    // render. The presetApply object identity is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetApply]);
}
