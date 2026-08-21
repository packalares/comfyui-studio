// Per-checkpoint inference defaults, mirroring ACE-Step's own table in
// `acestep/ui/gradio/events/generation/model_config.py`
// (`get_ui_control_config`).
//
// WHY THIS EXISTS: the three ACE-Step checkpoints are not interchangeable at
// the same settings, and sending one set of numbers to all of them produces
// badly degraded audio rather than an error. Turbo bakes guidance into its
// distillation and runs in 8 steps with CFG OFF; base and SFT are undistilled
// and need CFG ON with 4-6x the steps. Leaving both fields unset (what the UI
// did before) meant whichever model was loaded got the same treatment, so
// selecting base or SFT silently produced worse songs.
//
// Upstream detects the model type from tokens in the checkpoint path, with
// precedence turbo > SFT > pure base > fallback:
//
//     is_turbo = _has_token("turbo", config_path_lower)
//
// We mirror that precedence rather than matching exact checkpoint ids, so a
// future `acestep-v15-xl-turbo-v2` still resolves correctly.

export type AceModelKind = 'turbo' | 'sft' | 'base';

export interface ModelTuning {
  kind: AceModelKind;
  /** `inference_steps_value` upstream. */
  steps: number;
  /** `inference_steps_maximum` — turbo is clamped hard (ACE-Step itself caps
   *  turbo at 8 in `service_generate_request.py`), base/SFT go to 200. */
  maxSteps: number;
  /** Whether classifier-free guidance applies. Turbo forces guidance_scale to
   *  1.0 internally and logs the override, so exposing the control there is
   *  misleading — the value is ignored. */
  usesCfg: boolean;
  /**
   * Default guidance when CFG applies.
   *
   * Currently 2.0, and the honest state of the evidence is: nobody has
   * established the right value for this integration.
   *
   * History, because it has flip-flopped twice on thin evidence. It was 2.0 on
   * an over-guidance theory that later proved wrong (the garbling was DCW, not
   * CFG). It was then raised to upstream's 7.0 on the strength of ONE Gradio
   * parameter dump — which was a `complete` task on XL-Base, not a `cover` on
   * XL-SFT. Cover was audibly worse afterwards, so it is back at 2.0.
   *
   * What that actually justifies: 2.0 is the value this app shipped while
   * covers sounded acceptable. It is a restored baseline, NOT a measured
   * optimum. High CFG pushes a cover toward the text caption and away from the
   * source track, so the right default may well be task-dependent rather than
   * model-dependent — which is a change worth making only once someone has
   * compared them by ear on the same source track.
   */
  guidanceScale?: number;
  /** Safe CFG range for this model family, shown in the UI so a user raising
   *  guidance knows where the cliff is. */
  guidanceRange?: [number, number];
  /** Adaptive guidance is only meaningful when CFG is active. */
  supportsAdg: boolean;
  /** Human-readable note shown under the model picker. */
  note: string;
  /**
   * Set when the model produces unusable audio through the HTTP path. The
   * cause IS now known, and the fix does not live in this file.
   *
   * `dcw_enabled` (Differential Correction in Wavelet domain) defaults to
   * `True` in the pipeline
   * (`acestep/core/generation/handler/generate_music.py:212`) and is absent
   * from the API's 59-field request model, while the Python `GenerationParams`
   * carries 108 fields. So the HTTP path cannot vary it in either direction —
   * every REST generation gets DCW on. Correct for turbo; it wrecks SFT/Base.
   *
   * Confirmed rather than inferred: ACE-Step's own Gradio UI sets
   * `dcw_enabled_value: False` for the non-turbo checkpoints
   * (`ui/gradio/events/generation/model_config.py:140`), and a Gradio run of
   * XL-Base with `dcw_enabled=False`, guidance 7, `task_type=complete`
   * produced clean audio confirmed by ear. Gradio can do this because it calls
   * `generate_music()` in-process with the loaded handlers; we run ACE-Step as
   * a separate server and only have the REST surface.
   *
   * RESOLVED. The spawn-time patch in `server/src/services/aceStep/process.ts`
   * wraps `acestep.api_server.generate_music` and forces `dcw_enabled=False`
   * for non-turbo checkpoints, and SFT/Base were confirmed clean by ear
   * afterwards. No checkpoint currently sets this field; it stays defined
   * because "this model is unusable through our integration" is a state worth
   * being able to express loudly if it recurs.
   *
   * Historical note, because it cost several rounds: upstream's `docs/en/DCW.md`
   * says DCW is integrated for `xl_base`/`xl_sft`/`xl_turbo` alike and lists no
   * model as needing it disabled. That documentation was treated as refuting
   * the DCW hypothesis, and the hypothesis was dropped. The docs describe what
   * DCW *is*; the UI encodes what it *does* per model. Runtime behaviour won.
   */
  apiBroken?: string;
}

const TURBO: ModelTuning = {
  kind: 'turbo',
  steps: 8,
  maxSteps: 20,
  usesCfg: false,
  supportsAdg: false,
  note: 'Distilled — fastest, 8 steps, no guidance needed.',
};

const SFT: ModelTuning = {
  kind: 'sft',
  steps: 50,
  maxSteps: 200,
  usesCfg: true,
  guidanceScale: 2,
  guidanceRange: [1, 10],
  supportsAdg: true,
  note: 'Higher fidelity, 50 steps.',
};

const BASE: ModelTuning = {
  kind: 'base',
  steps: 32,
  maxSteps: 200,
  usesCfg: true,
  guidanceScale: 2,
  guidanceRange: [1, 10],
  supportsAdg: true,
  note: 'Undistilled base — the only model with Extract / Lego / Continue.',
};

/** Token match on word-ish boundaries, mirroring upstream's `_has_token` so
 *  `xl-turbo` matches but a name merely containing the letters does not. */
function hasToken(name: string, token: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${token}([^a-z0-9]|$)`, 'i').test(name);
}

/**
 * Resolve tuning for a checkpoint name. Order matters and follows upstream:
 * turbo wins over sft wins over base. An unrecognised name falls back to BASE
 * — the conservative direction, since base's settings (more steps + CFG) merely
 * run slower on a distilled model, whereas turbo's 8-step/no-CFG settings on an
 * undistilled model produce genuinely bad audio.
 */
export function tuningForModel(name: string | null | undefined): ModelTuning {
  const n = (name ?? '').toLowerCase();
  if (hasToken(n, 'turbo')) return TURBO;
  if (hasToken(n, 'sft')) return SFT;
  return BASE;
}
