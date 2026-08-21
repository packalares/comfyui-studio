// Generation modes for the Create tab, mirroring ACE-Step's OWN mode catalog
// rather than inventing a parallel one.
//
// Source of truth is the installed package's `acestep/constants.py`:
//
//   GENERATION_MODES_TURBO = ["Simple", "Custom", "Remix", "Repaint"]
//   GENERATION_MODES_BASE  = [...turbo, "Extract", "Lego", "Complete"]
//   MODE_TO_TASK_TYPE      = {Simple: text2music, Custom: text2music,
//                             Remix: cover, Repaint: repaint, Extract: extract,
//                             Lego: lego, Complete: complete}
//
// Two things that catalog encodes and this file must preserve:
//
//  1. AVAILABILITY IS MODEL-DEPENDENT. Turbo/SFT checkpoints support only the
//     first four modes; Extract/Lego/Complete need a *base* checkpoint
//     (`TASK_TYPES_TURBO` vs `TASK_TYPES_BASE`). Offering a mode the loaded
//     model can't run would fail deep inside ACE-Step with an opaque error, so
//     `modesForModel()` filters by the selected checkpoint instead.
//
//  2. "Simple" and "Custom" are the SAME task_type (`text2music`) — they differ
//     only in how much of the form the user fills in. That's why `customMode`
//     already exists as a boolean on the request; mode selection supersedes it
//     but must keep sending it so the server's Simple-mode orchestration
//     (description -> style/lyrics via ollama) still triggers.
//
// `audio2audio` is NOT an ACE-Step task type — it's our own alias that
// `services/ace/acestep.ts` maps onto `cover`. New UI uses `Remix`/`cover`
// directly; the alias stays only for older stored jobs.

export type TaskType =
  | 'text2music' | 'repaint' | 'cover' | 'cover-nofsq'
  | 'extract' | 'lego' | 'complete';

export type ModeId = 'Simple' | 'Custom' | 'Remix' | 'Repaint' | 'Extract' | 'Lego' | 'Complete';

/**
 * The one question the composer asks first: are you making something from
 * nothing, or changing a track you already have?
 *
 * This is deliberately NOT the same axis as the checkpoint. Mode answers "what
 * am I doing"; the model picker answers "how fast / how faithful". Keeping them
 * independent is what stops the UI implying that e.g. Remix is a turbo feature
 * — every mode below except the three expert ones runs on all three
 * checkpoints, and `modesForModel()` is the only thing allowed to narrow that.
 */
export type ModeGroup = 'create' | 'transform';

export const MODE_GROUP_LABEL: Record<ModeGroup, string> = {
  create: 'Create',
  transform: 'Transform',
};

/** Which extra controls a mode reveals. Drives the progressive form: the
 *  composer shows a mode picker first, then only that mode's fields. */
export interface ModeFields {
  /** Free-text song description (Simple only — server expands it via ollama). */
  description?: boolean;
  /** Style / lyrics / title trio. */
  composer?: boolean;
  /** Needs an input track (`src_audio_path`). */
  sourceAudio?: boolean;
  /** Optional second track used as a style reference (`reference_audio_path`). */
  referenceAudio?: boolean;
  /**
   * "Sound like…" — capture a track's style as audio codes (`audio_code_string`).
   *
   * Distinct from `referenceAudio` despite sounding similar, and the two are
   * offered together on purpose: a reference track is handed to ACE-Step as
   * audio for it to interpret, whereas codes ARE the model's own semantic
   * reading of the track, extracted up front via `POST /ace/analyze`. Codes
   * transfer style far more strongly, which is why this is the Create-mode
   * equivalent of Remix without needing the source material itself.
   */
  soundLike?: boolean;
  /** Cover strength + noise strength sliders. */
  coverStrength?: boolean;
  /** Repaint start/end region over the source track. */
  repaintRange?: boolean;
  /** Single instrument track to act on (`{TRACK_NAME}` in the instruction). */
  trackName?: boolean;
  /** Multiple instrument classes (`{TRACK_CLASSES}` in the instruction). */
  trackClasses?: boolean;
}

export interface ModeDef {
  id: ModeId;
  taskType: TaskType;
  label: string;
  /** One line, shown under the mode picker — plain language, not ACE-Step jargon. */
  description: string;
  /** Which half of the composer this belongs to. */
  group: ModeGroup;
  /** True when the mode needs a base checkpoint (not turbo/SFT). */
  baseOnly: boolean;
  /**
   * Hidden until the user opts into expert modes.
   *
   * These are the stem-level operations (pull an instrument out, layer one in,
   * continue an unfinished take). They're genuinely useful but they need a
   * source track AND a base checkpoint AND an understanding of what a stem is,
   * so surfacing them next to "Describe your song" made the first screen read
   * as a DAW rather than a prompt box. Everything expert is also `baseOnly`
   * today, but the two flags mean different things and shouldn't be merged:
   * `baseOnly` is a capability fact, `expert` is a presentation choice.
   */
  expert: boolean;
  fields: ModeFields;
}

export const MODES: ModeDef[] = [
  {
    id: 'Simple',
    taskType: 'text2music',
    label: 'Simple',
    description: 'Describe a NEW song in one line and let the model fill in the rest.',
    group: 'create',
    baseOnly: false,
    expert: false,
    fields: { description: true, soundLike: true },
  },
  {
    id: 'Custom',
    taskType: 'text2music',
    label: 'Custom',
    description: 'Write your own style tags and lyrics for full control.',
    group: 'create',
    baseOnly: false,
    expert: false,
    // A reference track is valid here, not just in Remix. ACE-Step routes an
    // attached audio by task type: for the src-audio tasks (cover/repaint) it
    // becomes `src_audio_path`, and for everything else — text2music included —
    // it becomes `reference_audio_path`, i.e. a STYLE reference rather than
    // source material. So "make something new that sounds like this" is a
    // supported text2music flow; gating the picker to Remix hid it.
    fields: { composer: true, referenceAudio: true, soundLike: true },
  },
  {
    id: 'Remix',
    taskType: 'cover',
    label: 'Remix',
    description: 'Re-record THIS song in a new style — same melody and structure, new sound.',
    group: 'transform',
    baseOnly: false,
    expert: false,
    fields: { composer: true, sourceAudio: true, referenceAudio: true, coverStrength: true },
  },
  {
    id: 'Repaint',
    taskType: 'repaint',
    label: 'Repaint',
    description: 'Regenerate one section of a track and leave the rest untouched.',
    group: 'transform',
    baseOnly: false,
    expert: false,
    fields: { composer: true, sourceAudio: true, repaintRange: true },
  },
  {
    id: 'Extract',
    taskType: 'extract',
    label: 'Extract',
    description: 'Pull a single instrument out of a track as its own stem.',
    group: 'transform',
    baseOnly: true,
    expert: true,
    fields: { sourceAudio: true, trackName: true },
  },
  {
    id: 'Lego',
    taskType: 'lego',
    label: 'Lego',
    description: 'Add a new instrument layer on top of an existing track.',
    group: 'transform',
    baseOnly: true,
    expert: true,
    fields: { composer: true, sourceAudio: true, trackName: true },
  },
  {
    id: 'Complete',
    taskType: 'complete',
    // Labelled "Continue" but keyed `Complete`: the id and task_type are wire
    // values ACE-Step and our stored jobs both use, so they stay put. Only the
    // human-facing string changes — "Complete" reads as "finish/fill in a form
    // field" to anyone who hasn't read upstream's catalog, while continuing an
    // unfinished take is exactly what it does.
    label: 'Continue',
    description: 'Continue an unfinished track, optionally adding named instruments.',
    group: 'transform',
    baseOnly: true,
    expert: true,
    fields: { composer: true, sourceAudio: true, trackClasses: true },
  },
];

export const MODE_BY_ID: Record<ModeId, ModeDef> = Object.fromEntries(
  MODES.map((m) => [m.id, m]),
) as Record<ModeId, ModeDef>;

/**
 * Modes the given checkpoint can actually run.
 *
 * Driven by the checkpoint's OWN `config.json` `is_turbo` flag, surfaced on
 * `AceModelInfo.is_turbo` — the same value ACE-Step reads in
 * `_read_model_supported_tasks` to pick `TASK_TYPES_TURBO` vs the full
 * `TASK_TYPES_BASE`.
 *
 * This previously pattern-matched the checkpoint NAME for "base", which was
 * actively wrong for a shipped model: `acestep-v15-xl-sft` reports
 * `is_turbo: false`, so ACE-Step grants it Extract/Lego/Complete — but its
 * name has no "base" in it, so the UI hid all three. Reading the flag fixes
 * that and stops the two systems disagreeing whenever a checkpoint is renamed.
 *
 * `null` (config missing/unreadable, or the model list hasn't loaded) is
 * treated as turbo: hide the base-only modes. Hiding a usable mode is a
 * strictly better failure than offering one that dies opaquely inside
 * ACE-Step mid-generation.
 */
export function modesForModel(
  isTurbo: boolean | null | undefined,
  modelName?: string | null,
  opts?: { expert?: boolean },
): ModeDef[] {
  // Extract/Lego/Complete are PURE-BASE only, not merely non-turbo. Upstream's
  // own docs are explicit ("Extract Mode (Base Model Only)") and its UI gates
  // them on `is_pure_base_model` = name has "base" AND has neither "sft" nor
  // "turbo". Gating on `is_turbo === false` alone wrongly offered all three on
  // the SFT checkpoint, which reports `is_turbo: false` but is not a base model.
  //
  // Note upstream contradicts itself here: the HTTP API's
  // `_read_model_supported_tasks` gates on `config.json`'s `is_turbo` and so
  // WOULD accept these task types for SFT, while the UI and docs restrict them
  // to base. We follow the stricter UI/doc behaviour — the API accepting a
  // request is not evidence the model produces usable output for it.
  const name = (modelName ?? '').toLowerCase();
  const hasToken = (t: string) => new RegExp(`(^|[\\\\/._-])${t}($|[\\\\/._-])`).test(name);
  const isPureBase = isTurbo === false && hasToken('base') && !hasToken('sft');
  // Two independent filters, deliberately not collapsed into one condition.
  // Capability first (can this checkpoint run it at all), then presentation
  // (has the user asked to see the stem-level tools). A mode hidden by the
  // expert flag is still perfectly runnable — flipping the switch reveals it
  // without touching the model.
  return MODES.filter((m) => (isPureBase || !m.baseOnly) && (opts?.expert || !m.expert));
}

/** Modes for one half of the composer, preserving catalog order. */
export function modesInGroup(modes: ModeDef[], group: ModeGroup): ModeDef[] {
  return modes.filter((m) => m.group === group);
}

/**
 * Whether a checkpoint has any expert mode to reveal.
 *
 * Used to hide the expert toggle itself on turbo/SFT: offering a switch that
 * demonstrably does nothing is worse than not offering it, because the user
 * concludes the feature is broken rather than that their model lacks it.
 */
export function hasExpertModes(
  isTurbo: boolean | null | undefined,
  modelName?: string | null,
): boolean {
  return modesForModel(isTurbo, modelName, { expert: true })
    .some((m) => m.expert);
}

/**
 * Instrument tracks Extract/Lego/Continue can target.
 *
 * VERBATIM from ACE-Step's `constants.py` `TRACK_NAMES`, and it must stay
 * that way — these strings are substituted into the task instruction
 * (`"Extract the {TRACK_NAME} track from the audio:"`) and passed as
 * `track_classes`, so a name the model was never trained on is a silently
 * degraded generation rather than an error.
 *
 * This previously listed `piano`, which upstream does NOT have (its keyboard
 * family is `keyboard`), and omitted `percussion`, `keyboard` and
 * `backing_vocals` entirely.
 */
export const TRACK_NAMES = [
  'vocals', 'backing_vocals', 'drums', 'percussion', 'bass', 'guitar',
  'keyboard', 'strings', 'synth', 'brass', 'woodwinds', 'fx',
] as const;
