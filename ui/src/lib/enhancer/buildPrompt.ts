// Pure-function assembly of the prompt-enhancer messages.
//
// Takes the (already-fetched) profile + master header/footer + the user's
// operation / length / genre picks + the raw idea, and produces the
// `messages: [{role:'system',...}, {role:'user',...}]` array that gets
// POSTed to /api/llm/chat — exactly the same shape the existing Enhance
// flow uses today.
//
// No React, no fetch, no side effects — this function is unit-testable
// in isolation. The caller is responsible for resolving the profileId
// to a full Profile (via fetchEnhancerProfile) before invoking.

import type {
  EnhancerBundle,
  EnhancerProfile,
  EnhancerExample,
} from './profileClient.js';

export type OperationKey = 'expand' | 'refine' | 'restyle' | 'enrich';

// One of EricRollei's 4 word-count tiers — concise / moderate / detailed
// / exhaustive — defined in operations.json. The profile's
// max_words/min_word_floor get scaled by the tier's multiplier so the
// same profile can produce a tight 90-word output OR an exhaustive 600-
// word output without writing two profiles.
export type LengthTier = 'concise' | 'moderate' | 'detailed' | 'exhaustive';

export interface BuildPromptOptions {
  profile: EnhancerProfile;
  bundle: EnhancerBundle;

  /** User's text idea — the seed the LLM will expand / refine. */
  rawIdea: string;

  /** Active Studio mode key (`t2i_flux_dev`, `i2i_kontext1`, …). Passed
   *  to the LLM via the user-message JSON so the model knows which
   *  Studio mode it's writing for, even when one profile covers several
   *  modes (e.g. flux2_prose covers t2i_flux_dev + t2i_flux_klein_9b). */
  targetMode: string;

  /** Higher-level operation; defaults to 'expand'. */
  operation?: OperationKey;

  /** Length tier; falls back to the profile's default_length_tier. */
  length?: LengthTier;

  /** Genre name from bundle.genres (e.g. 'cinematic', 'noir', 'cyberpunk').
   *  Falls through to 'auto' = no genre injection. */
  genre?: string;

  /** Optional structured camera details (lens, aperture, sensor) gathered
   *  by Studio's CameraSettingsModal. Null/undefined fields are stripped. */
  cameraLabels?: {
    lens?: string | null;
    aperture?: string | null;
    camera?: string | null;
    focal_length?: string | null;
  };

  /** Optional reference image metadata (filename + caption per ref). */
  references?: Array<{
    label: string;
    filename: string;
    caption?: string;
  }>;

  /** Number of image attachments — informs the model whether it's t2i or
   *  i2i context. The base64 bytes themselves are passed separately on
   *  the user message via the existing /api/llm/chat `images: []` slot. */
  sourceImageCount?: number;

  /** Aspect ratio chosen for this render (e.g. '16:9'). */
  aspectRatio?: string;
}

export interface BuildPromptResult {
  /** [{role:'system',...}, {role:'user',...}] — POST to /api/llm/chat. */
  messages: Array<{ role: 'system' | 'user'; content: string }>;

  /** Sampling overrides — pass through to /api/llm/chat options to keep
   *  per-profile temperature / num_predict tuning intact. */
  options: {
    temperature: number;
    top_p: number;
    num_predict: number;
  };

  /** Preferred LLM model id for THIS profile + image-attachment state.
   *  Pass to /api/llm/chat `model: ...` — overrides the caller's default. */
  preferredModel: string;
}

/**
 * Assemble messages + sampling options from a profile + user picks.
 *
 * Layering precedence (highest wins):
 *
 *   1. operation_overrides[op] — per-profile per-operation tweaks
 *   2. length_tier scaling     — bundle.operations.length_tiers[tier]
 *   3. profile defaults        — max_words, min_word_floor, length_guidance
 *
 * The system prompt is the concatenation:
 *
 *   master.header (with platform_name placeholders substituted)
 *   + OUTPUT INTENSITY GUIDANCE (length, detail)
 *   + PLATFORM REQUIREMENTS (preferences)
 *   + QUALITY TOKENS (if profile.quality_emphasis)
 *   + REQUIRED TOKENS (if profile.required_positive)
 *   + AVOID
 *   + USER REQUIREMENTS (length, detail, genre, prompt context)
 *   + platform_block (the per-profile directive paragraph)
 *   + few-shot examples (if any)
 *   + master.footer
 */
export function buildEnhancerMessages(opts: BuildPromptOptions): BuildPromptResult {
  const { profile, bundle, rawIdea, targetMode } = opts;
  const operation: OperationKey = opts.operation ?? 'expand';
  const lengthTier: LengthTier =
    (opts.length ?? profile.default_length_tier) as LengthTier;
  const genre = opts.genre && opts.genre !== 'auto' ? opts.genre : null;

  // ---- 1. Resolve length + word-count from layered overrides --------
  const opOverride = profile.operation_overrides?.[operation] ?? {};
  const tier = bundle.operations.length_tiers[lengthTier];
  const tierMultiplier = tier?.max_words_multiplier ?? 1;
  const maxWords =
    opOverride.max_words ?? Math.round(profile.max_words * tierMultiplier);
  const minWordFloor = Math.min(
    opOverride.min_word_floor ?? profile.min_word_floor,
    maxWords,
  );
  const lengthGuidance =
    opOverride.length_guidance ?? profile.length_guidance;

  // ---- 2. Resolve genre guidance ------------------------------------
  const genreGuidance = genre ? bundle.genres.genres[genre] : null;

  // ---- 3. Resolve prompt-context (from operation → context_map) -----
  const opDef = bundle.operations.operations[operation];
  const contextKey = opDef?.default_context;
  const contextGuidance = contextKey
    ? bundle.operations.context_map[contextKey]
    : null;

  // ---- 4. Assemble system prompt ------------------------------------
  const sections: string[] = [];

  // Header — substitute {placeholder} tokens against the profile fields.
  sections.push(
    interpolate(bundle.master.header, {
      platform_name: profile.name,
      platform_description: profile.description,
      prompt_style: profile.prompt_style ?? profile.format,
      optimal_length: lengthGuidance,
    }),
  );

  // Output intensity — re-emphasised because long-output enforcement
  // works best when stated multiple times in the prompt (EricRollei's
  // pattern; works across model sizes).
  sections.push(
    `OUTPUT INTENSITY GUIDANCE:\n` +
      `- Minimum acceptable length: ${minWordFloor} words. Falling short ` +
      `counts as a failure.\n` +
      `- Target length: ${lengthGuidance}\n` +
      `- Detail expectation: ${profile.detail_expectation}`,
  );

  // Platform-specific preferences (bullet list from the profile).
  if (profile.preferences.length > 0) {
    sections.push(
      'PLATFORM REQUIREMENTS:\n' +
        profile.preferences.map((p) => `- ${p}`).join('\n'),
    );
  }

  // Quality tokens, conditionally on profile.quality_emphasis.
  if (
    profile.quality_emphasis !== false &&
    profile.quality_tokens.length > 0
  ) {
    sections.push(
      'QUALITY TOKENS (use appropriately): ' +
        profile.quality_tokens.slice(0, 8).join(', '),
    );
  }

  // Required positive tokens (e.g. Pony's score_X).
  if (profile.required_positive.length > 0) {
    sections.push(
      'REQUIRED TOKENS (must include): ' +
        profile.required_positive.join(', '),
    );
  }

  // Avoid list.
  if (profile.avoid.length > 0) {
    sections.push(
      'AVOID:\n' + profile.avoid.map((a) => `- ${a}`).join('\n'),
    );
  }

  // User requirements — operation + length + genre + context.
  const userReqs: string[] = ['=== USER REQUIREMENTS ==='];
  userReqs.push(`OPERATION: ${operation} (${opDef?.description ?? operation})`);
  userReqs.push(`LENGTH TIER: ${lengthTier} (${tier?.word_range ?? ''})`);
  userReqs.push(
    `ABSOLUTE MINIMUM DETAIL: deliver no fewer than ${minWordFloor} words.`,
  );
  if (genreGuidance) {
    userReqs.push(
      `STYLE/GENRE: ${genre} — infuse the prompt with ${genreGuidance}`,
    );
  }
  if (contextGuidance) {
    userReqs.push(`PROMPT CONTEXT: ${contextGuidance}`);
  }
  userReqs.push(
    'BASE PROMPT PRIORITY:\n' +
      "- The user's text prompt is the authoritative subject. Preserve " +
      'its characters, actions, and tone.\n' +
      '- Genre, references, and camera details must enhance — not replace — the base concept.',
  );
  sections.push(userReqs.join('\n'));

  // Profile's bespoke platform_block — the per-model directive paragraph.
  if (profile.platform_block.trim()) {
    sections.push(profile.platform_block.trim());
  }

  // Few-shot examples.
  if (profile.examples.length > 0) {
    const fewShot = profile.examples.map(formatExample).join('\n\n');
    const intro =
      profile.few_shot_intro ??
      'Example transformations of a user idea into the target format:';
    sections.push(`${intro}\n\n${fewShot}`);
  }

  // user_message_schema_hint — tells the LLM what the user JSON
  // contains. Optional but useful for profiles that route camera_details
  // through structured fields.
  if (profile.user_message_schema_hint?.trim()) {
    sections.push(profile.user_message_schema_hint.trim());
  }

  // Footer — the closing "ONLY the prompt, no Settings: list" rules.
  sections.push(bundle.master.footer);

  const systemPrompt = sections.join('\n\n');

  // ---- 5. Assemble user message JSON --------------------------------
  // Mirrors the existing builder.shared.tsx payload shape so we don't
  // break templates that still parse it via their (legacy) systemPrompt.
  const userPayload: Record<string, unknown> = {
    raw_idea: rawIdea,
    target_model: targetMode,
    operation,
    length_tier: lengthTier,
  };
  if (opts.sourceImageCount !== undefined) {
    userPayload.source_image_count = opts.sourceImageCount;
  }
  if (opts.aspectRatio) {
    userPayload.aspect_ratio = opts.aspectRatio;
  }
  if (opts.cameraLabels) {
    const cd: Record<string, string> = {};
    if (opts.cameraLabels.lens) cd.lens = opts.cameraLabels.lens;
    if (opts.cameraLabels.aperture) cd.aperture = opts.cameraLabels.aperture;
    if (opts.cameraLabels.camera) cd.film_or_sensor = opts.cameraLabels.camera;
    if (opts.cameraLabels.focal_length) {
      cd.focal_length = opts.cameraLabels.focal_length;
    }
    if (Object.keys(cd).length > 0) {
      userPayload.camera_details = cd;
    }
  }
  if (opts.references && opts.references.length > 0) {
    userPayload.references = opts.references;
  }
  if (genre) {
    userPayload.genre = genre;
  }

  // ---- 6. Pick LLM model + sampling --------------------------------
  const hasImages = (opts.sourceImageCount ?? 0) > 0;
  const preferredModel =
    hasImages && profile.model_routing.prefer_vlm_when_images_attached
      ? profile.model_routing.preferred_vlm
      : profile.model_routing.preferred_llm;

  // Scale num_predict by the length tier so a 'concise' enhance doesn't
  // burn the budget for an 'exhaustive' one.
  const numPredict = Math.round(
    profile.model_routing.sampling.num_predict * tierMultiplier,
  );

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(userPayload, null, 2) },
    ],
    options: {
      temperature: profile.model_routing.sampling.temperature,
      top_p: profile.model_routing.sampling.top_p,
      num_predict: numPredict,
    },
    preferredModel,
  };
}

// ---- helpers --------------------------------------------------------

function interpolate(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? `{${key}}`);
}

function formatExample(ex: EnhancerExample): string {
  const parts = [`User: ${ex.user_input}`, `Ideal output: ${ex.ideal_output}`];
  if (ex.note) parts.push(`(${ex.note})`);
  return parts.join('\n');
}
