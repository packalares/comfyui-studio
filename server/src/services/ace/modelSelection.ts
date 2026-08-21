// DiT checkpoint / 5Hz-LM selection for ACE-Step generation requests —
// applied via `switchModel()`/`POST /v1/init` before every generation (see
// `ensureAceStepModelLoaded`). Pulled out of `routes/ace/generate.routes.ts`
// (already near `tests/structure.test.ts`'s 900-line cap) into its own
// module, same reasoning as `ollamaAssist.ts`'s extraction: route files stay
// thin, resolution logic lives beside the other pack/model helpers it calls.
//
// Previously `switchModel()` was dead code — nothing called it, so whatever
// checkpoint ACE-Step happened to auto-load (its own default, not
// necessarily the pack's) silently served every request regardless of what
// the UI's model picker showed as selected.

import path from 'path';
import * as packModelsRepo from '../../lib/db/packModels.repo.js';
import { getAceStepProcessService } from '../aceStep/process.js';
import { PACKS, type PackModelDef } from '../packs/registry.js';
import { effectiveDest, effectiveRepo } from '../packs/settings.js';
import * as aceStep from './acestep.js';

/** On-disk leaf directory name for one registry model entry (`checkpoint` and
 *  `lm` both resolve into the same `<ace-step models root>/checkpoints/`
 *  tree — see `modelPaths.ts`'s `resolvePackModelDest` doc comment — so a
 *  bare basename is correct for both kinds, matching how ACE-Step itself
 *  resolves `POST /v1/init`'s `model`/`lm_model_path` fields relative to its
 *  own `<project_root>/checkpoints/`). */
function modelDirName(model: PackModelDef): string {
  const dest = effectiveDest(
    'ace-step', model.id, model.kind,
    effectiveRepo('ace-step', model.id, model.repo), model.repoSubfolder,
  );
  return path.basename(dest);
}

/** Resolve the DiT checkpoint name a generation request should load: the
 *  request's own `ditModel` (the UI's per-session picker) if set, else the
 *  `generate.ditModel` pack setting (registry.ts's `PackSettingDef`), else
 *  the registry's `default: true` checkpoint. */
export function resolveEffectiveDitModel(requested: string | null | undefined): string {
  if (requested) return requested;
  const configured = packModelsRepo.getSetting('ace-step', 'generate.ditModel');
  if (configured) return configured;
  const checkpointModels = PACKS['ace-step'].models.filter((m) => m.kind === 'checkpoint');
  const def = checkpointModels.find((m) => m.default) ?? checkpointModels[0];
  if (!def) throw new Error('ace-step pack declares no checkpoint models');
  return modelDirName(def);
}

/** Resolve the 5Hz-LM backend a generation request should load: the
 *  `generate.lmModel` pack setting if set, else the registry's `default:
 *  true` LM (see registry.ts's comment on `lm-1.7b` for why that's the
 *  default rather than `lm-0.6b`). */
export function resolveEffectiveLmModel(): string {
  const configured = packModelsRepo.getSetting('ace-step', 'generate.lmModel');
  if (configured) return configured;
  const lmModels = PACKS['ace-step'].models.filter((m) => m.kind === 'lm');
  const def = lmModels.find((m) => m.default) ?? lmModels[0];
  if (!def) throw new Error('ace-step pack declares no LM models');
  return modelDirName(def);
}

/**
 * Load the given DiT checkpoint + 5Hz-LM pair via `POST /v1/init` unless
 * it's already what the process service tracked as loaded
 * (`AceStepProcessService.getLoadedModel`) — a `/v1/init` round-trip reloads
 * multi-GB weights, so repeating it on every single generation request (the
 * common case: same model, back-to-back requests) would be a multi-second
 * tax per job for no reason.
 *
 * `init_llm` is NOT unconditionally true. ACE-Step's own UI disables the LM
 * for a pure base checkpoint:
 *
 *     init_llm_update = gr.update(value=False) if is_pure_base else gr.update()
 *     (ui/gradio/events/generation/model_config.py)
 *
 * We were sending `true` for every checkpoint, including base. Base is the
 * undistilled model — it is not trained to consume the 5Hz LM's semantic
 * tokens the way turbo/SFT are, and upstream turning the LM off for it
 * specifically is a strong signal that pairing them is not a supported
 * configuration.
 */
export async function ensureAceStepModelLoaded(ditModel: string, lmModel: string): Promise<void> {
  const svc = getAceStepProcessService();
  const initLlm = !isPureBaseModel(ditModel);
  // The LM is part of the loaded-state identity: switching between a base
  // model (LM off) and turbo (LM on) must re-init even if the LM name matches,
  // otherwise the second request reuses a process that has the wrong LM state.
  const lmKey = initLlm ? lmModel : '(none)';
  const loaded = svc.getLoadedModel();
  if (loaded && loaded.dit === ditModel && loaded.lm === lmKey) return;

  /*
   * SWITCHING MODELS RESTARTS THE PROCESS. `POST /v1/init` is not sufficient.
   *
   * ACE-Step frees the previous DiT on re-init
   * (`init_service_loader.py`: `del self.model` + `torch.cuda.empty_cache()`),
   * but there is NO endpoint that frees the 5Hz LM, and nothing releases it
   * when a later `/v1/init` passes `init_llm: false`. The entire HTTP surface
   * has exactly one unload route — `/v1/lora/unload` — and none for models.
   *
   * So the SFT/turbo -> base direction is the sharp edge: SFT loads the LM,
   * base asks for `init_llm: false`, and the LM stays resident on a card that
   * now also has to hold the base DiT plus VAE activations. On a 24 GB card
   * that reliably OOMs partway through, typically inside the source-audio VAE
   * encode, which reads as "the cover crashed" rather than "the previous
   * model was never freed".
   *
   * Restarting is the only reclaim we actually control. It costs a cold start,
   * but a model switch already pays a multi-GB load, so the extra cost is the
   * process spawn — cheap next to a failed generation. Same-model requests
   * still short-circuit above and never restart.
   */
  if (loaded) {
    await svc.restartAceStep();
    svc.setLoadedModel(null);
  }

  await aceStep.switchModel(ditModel, {
    initLlm,
    lmModelPath: initLlm ? lmModel : '',
  });
  svc.setLoadedModel({ dit: ditModel, lm: lmKey });
}

/**
 * Mirrors upstream's `is_pure_base_model` (`model_config.py`) exactly: the
 * name contains "base" AND contains neither "sft" nor "turbo". Upstream uses
 * this same name-token test — unlike the mode-availability gate, which reads
 * `config.json`'s `is_turbo` — so matching its logic here is deliberate rather
 * than a shortcut.
 */
function isPureBaseModel(name: string): boolean {
  const n = name.toLowerCase();
  const token = (t: string) => new RegExp(`(^|[\\\\/._-])${t}($|[\\\\/._-])`).test(n);
  return token('base') && !token('sft') && !token('turbo');
}
