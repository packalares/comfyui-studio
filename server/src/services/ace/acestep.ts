// ACE-Step 1.5 FastAPI client. Ported from ace-step-ui's
// `server/src/services/acestep.ts`.
//
// This module assumes the FastAPI backend is already up and reachable at
// `env.ACESTEP_API_URL` — `services/aceStep/process.ts` (spawn/health-poll)
// and `services/gpu/residency.ts` (`ensureResident('ace-step')`, called from
// inside the scheduler before a job's `run()` fires) own bringing it up.
// Nothing here starts/stops the process.
//
// Dropped relative to ace-step-ui's version:
//   - The in-memory job queue (`activeJobs`/`jobQueue`/`processQueue`) —
//     comfy's GPU scheduler (`submitGpuJob('ace-step-generate', ...)`) IS the
//     queue now; see `routes/ace/generate.routes.ts`.
//   - `resolveAudioPath`'s copy-to-`/tmp` step — ace-step-ui needed that
//     because its ACE-Step process could be a separate container with a
//     different mount namespace. Here `getAceStepProcessService` spawns
//     `python3` as a plain child of this same Node process (see
//     `services/aceStep/process.ts`), so it shares comfy's filesystem
//     namespace and can read any absolute path directly — no copy needed.

import { existsSync } from 'fs';
import { env } from '../../config/env.js';
import { UpstreamUnavailableError } from '../../lib/errors.js';

function apiBase(): string {
  return env.ACESTEP_API_URL;
}

export async function fetchAPI<T = unknown>(
  endpoint: string,
  body?: unknown,
  fetchOpts?: { method?: string; timeoutMs?: number },
): Promise<T> {
  const url = `${apiBase()}${endpoint}`;
  const opts: RequestInit = {
    method: fetchOpts?.method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  if (fetchOpts?.timeoutMs) opts.signal = AbortSignal.timeout(fetchOpts.timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, opts);
  } catch (err) {
    throw new UpstreamUnavailableError(`ACE-Step API unreachable: ${endpoint}`, {
      message: err instanceof Error ? err.message : String(err),
    });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new UpstreamUnavailableError(`ACE-Step API ${endpoint} failed: ${res.status}`, {
      status: res.status,
      body: text.slice(0, 2000),
    });
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Generation params (camelCase wire shape — mirrors ace-step-ui's
// GenerationParams so the UI port can reuse the same field names)
// ---------------------------------------------------------------------------

export interface GenerationParams {
  customMode: boolean;
  songDescription?: string;
  lyrics: string;
  style: string;
  title: string;
  instrumental: boolean;
  vocalLanguage?: string;
  duration?: number;
  bpm?: number;
  keyScale?: string;
  timeSignature?: string;
  inferenceSteps?: number;
  guidanceScale?: number;
  batchSize?: number;
  randomSeed?: boolean;
  seed?: number;
  thinking?: boolean;
  enhance?: boolean;
  audioFormat?: string;
  inferMethod?: string;
  shift?: number;
  lmTemperature?: number;
  lmCfgScale?: number;
  lmTopK?: number;
  lmTopP?: number;
  lmNegativePrompt?: string;
  referenceAudioUrl?: string;
  sourceAudioUrl?: string;
  audioCodes?: string;
  repaintingStart?: number;
  repaintingEnd?: number;
  instruction?: string;
  audioCoverStrength?: number;
  coverNoiseStrength?: number;
  taskType?: string;
  useAdg?: boolean;
  cfgIntervalStart?: number;
  cfgIntervalEnd?: number;
  customTimesteps?: string;
  useCotMetas?: boolean;
  useCotCaption?: boolean;
  useCotLanguage?: boolean;
  autogen?: boolean;
  constrainedDecodingDebug?: boolean;
  allowLmBatch?: boolean;
  getScores?: boolean;
  getLrc?: boolean;
  scoreScale?: number;
  lmBatchChunkSize?: number;
  trackName?: string;
  completeTrackClasses?: string[];
  isFormatCaption?: boolean;
  ditModel?: string;
  repaintMode?: string;
  repaintStrength?: number;
  enableNormalization?: boolean;
  normalizationDb?: number;
  fadeInDuration?: number;
  fadeOutDuration?: number;
  mp3Bitrate?: string;
  mp3SampleRate?: number;
}

/**
 * Resolve a reference/source audio param to an absolute filesystem path the
 * ACE-Step process can read directly. Accepts either a `storage.ts`-minted
 * URL (`/api/ace/audio/<kind>/<key>`) or an already-absolute path. Returns
 * null for anything else (e.g. a bare http(s) URL — ACE-Step's REST API only
 * takes on-disk paths, so remote references aren't supported here).
 */
export function resolveReferenceAudioPath(
  audioUrlOrPath: string,
  resolveLocalUrl: (url: string) => string | null,
): string | null {
  const localPath = resolveLocalUrl(audioUrlOrPath);
  if (localPath) return existsSync(localPath) ? localPath : null;
  if (audioUrlOrPath.startsWith('/') && existsSync(audioUrlOrPath)) return audioUrlOrPath;
  return null;
}

function buildReleaseTaskBody(
  params: GenerationParams,
  resolveLocalUrl: (url: string) => string | null,
): Record<string, unknown> {
  const caption = params.style || 'pop music';
  const prompt = params.customMode ? caption : (params.songDescription || caption);
  const lyrics = params.instrumental ? '[Instrumental]' : (params.lyrics || '');
  const isThinking = params.thinking ?? false;
  const isEnhance = params.enhance ?? false;
  const useCot = isEnhance || isThinking;

  return {
    prompt,
    lyrics,
    thinking: isThinking,
    sample_mode: params.autogen ?? false,
    sample_query: params.songDescription || '',
    use_format: params.isFormatCaption ?? false,

    bpm: params.bpm && params.bpm > 0 ? params.bpm : null,
    key_scale: params.keyScale || '',
    time_signature: params.timeSignature || '',
    vocal_language: params.vocalLanguage || 'en',
    audio_duration: params.duration && params.duration > 0 ? params.duration : null,
    batch_size: Math.min(Math.max(params.batchSize ?? 2, 1), 16),

    inference_steps: params.inferenceSteps ?? 8,
    guidance_scale: params.guidanceScale ?? 7.0,
    use_random_seed: params.randomSeed !== false,
    seed: params.seed ?? -1,
    shift: params.shift ?? 3.0,
    infer_method: params.inferMethod || 'ode',

    task_type: (params.taskType === 'audio2audio' ? 'cover' : params.taskType) || 'text2music',
    instruction: params.instruction || '',

    reference_audio_path: params.referenceAudioUrl
      ? resolveReferenceAudioPath(params.referenceAudioUrl, resolveLocalUrl)
      : null,
    src_audio_path: params.sourceAudioUrl
      ? resolveReferenceAudioPath(params.sourceAudioUrl, resolveLocalUrl)
      : null,

    audio_cover_strength: params.audioCoverStrength ?? 1.0,
    cover_noise_strength: params.coverNoiseStrength ?? 0.0,
    repainting_start: params.repaintingStart ?? 0.0,
    repainting_end: params.repaintingEnd ?? -1,
    repaint_mode: params.repaintMode || 'balanced',
    repaint_strength: params.repaintStrength ?? 0.5,

    lm_temperature: params.lmTemperature ?? 0.85,
    lm_cfg_scale: params.lmCfgScale ?? 2.0,
    lm_top_k: params.lmTopK ?? 0,
    lm_top_p: params.lmTopP ?? 0.9,
    lm_negative_prompt: params.lmNegativePrompt || 'NO USER INPUT',

    use_cot_metas: useCot ? (params.useCotMetas ?? true) : false,
    use_cot_caption: useCot ? (params.useCotCaption ?? true) : false,
    use_cot_language: useCot ? (params.useCotLanguage ?? true) : false,
    use_constrained_decoding: true,
    constrained_decoding_debug: params.constrainedDecodingDebug ?? false,
    allow_lm_batch: params.allowLmBatch ?? true,
    lm_batch_chunk_size: params.lmBatchChunkSize ?? 8,

    use_adg: params.useAdg ?? false,
    cfg_interval_start: params.cfgIntervalStart ?? 0.0,
    cfg_interval_end: params.cfgIntervalEnd ?? 1.0,
    custom_timesteps: params.customTimesteps || '',

    audio_format: params.audioFormat || 'flac',
    mp3_bitrate: params.mp3Bitrate || '192k',
    mp3_sample_rate: params.mp3SampleRate || 48000,
    enable_normalization: params.enableNormalization ?? true,
    normalization_db: params.normalizationDb ?? -1.0,
    fade_in_duration: params.fadeInDuration ?? 0.0,
    fade_out_duration: params.fadeOutDuration ?? 0.0,

    get_scores: params.getScores ?? false,
    get_lrc: params.getLrc ?? false,
    score_scale: params.scoreScale ?? 0.5,

    audio_codes: params.audioCodes || '',
    track_name: params.trackName || null,
    complete_track_classes: params.completeTrackClasses || [],
    model: params.ditModel || null,
  };
}

export interface SubmitGenerationResult {
  taskId: string;
}

/** POST /release_task — submit a generation job, returns the ACE-Step task id. */
export async function submitGeneration(
  params: GenerationParams,
  resolveLocalUrl: (url: string) => string | null,
): Promise<SubmitGenerationResult> {
  const body = buildReleaseTaskBody(params, resolveLocalUrl);
  const resp = await fetchAPI<{ data?: { task_id?: string } }>('/release_task', body);
  const taskId = resp?.data?.task_id;
  if (!taskId) {
    throw new UpstreamUnavailableError(`ACE-Step /release_task returned no task_id: ${JSON.stringify(resp)}`);
  }
  return { taskId };
}

export interface TaskQueryResult {
  completed: boolean;
  failed: boolean;
  progress: number;
  stage: string;
  audioFileUrls: string[]; // ACE-Step-side URLs like /v1/audio?path=...
  error?: string;
  duration?: number;
  bpm?: number;
  keyScale?: string;
  timeSignature?: string;
  raw?: unknown;
}

interface QueryResultJob {
  status?: number; // 0=running, 1=succeeded, 2=failed
  result?: unknown;
  progress_text?: string;
}

interface QueryResultItem {
  file?: string;
  progress?: number;
  stage?: string;
  error?: string;
  metas?: {
    duration?: number;
    bpm?: number;
    keyscale?: string;
    timesignature?: string;
  };
}

/** POST /query_result — poll a single task's status. */
export async function queryTask(taskId: string): Promise<TaskQueryResult | null> {
  const resp = await fetchAPI<{ data?: QueryResultJob[] }>('/query_result', {
    task_id_list: JSON.stringify([taskId]),
  });
  const data = resp?.data;
  if (!Array.isArray(data) || data.length === 0) return null;

  const job = data[0];
  let resultItems: QueryResultItem[] = [];
  try {
    resultItems = typeof job.result === 'string'
      ? JSON.parse(job.result) as QueryResultItem[]
      : (job.result as QueryResultItem[] | undefined) ?? [];
  } catch {
    resultItems = [];
  }

  if (job.status === 1) {
    const audioFileUrls = resultItems.filter((r) => !!r.file).map((r) => r.file!);
    const metas = resultItems[0]?.metas ?? {};
    return {
      completed: true,
      failed: false,
      progress: 1,
      stage: 'Done',
      audioFileUrls,
      duration: metas.duration,
      bpm: metas.bpm,
      keyScale: metas.keyscale,
      timeSignature: metas.timesignature,
      raw: job,
    };
  }

  if (job.status === 2) {
    return {
      completed: false,
      failed: true,
      progress: 0,
      stage: 'Failed',
      audioFileUrls: [],
      error: resultItems[0]?.error || job.progress_text || 'Generation failed',
    };
  }

  return {
    completed: false,
    failed: false,
    progress: resultItems[0]?.progress ?? 0,
    stage: resultItems[0]?.stage || job.progress_text || 'Generating...',
    audioFileUrls: [],
  };
}

/** Download one of ACE-Step's own `/v1/audio?path=...`-style URLs to a Buffer. */
export async function downloadAudioToBuffer(aceAudioUrl: string): Promise<Buffer> {
  const url = aceAudioUrl.startsWith('http') ? aceAudioUrl : `${apiBase()}${aceAudioUrl}`;
  let resp: Response;
  try {
    resp = await fetch(url);
  } catch (err) {
    throw new UpstreamUnavailableError('Failed to download audio from ACE-Step', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
  if (!resp.ok) {
    throw new UpstreamUnavailableError(`Failed to download audio: ${resp.status}`);
  }
  return Buffer.from(await resp.arrayBuffer());
}

/** Best-effort cleanup of a completed/failed ACE-Step task. Never throws. */
export function cleanupTask(taskId: string): void {
  fetchAPI(`/cleanup/${encodeURIComponent(taskId)}`, {}).catch(() => { /* best-effort */ });
}

// ---------------------------------------------------------------------------
// Model management
// ---------------------------------------------------------------------------

export interface ModelInventoryEntry {
  name: string;
  is_loaded?: boolean;
  [key: string]: unknown;
}

export async function getModelInventory(): Promise<ModelInventoryEntry[]> {
  const resp = await fetchAPI<{ data?: { models?: ModelInventoryEntry[] } }>('/v1/model_inventory');
  return resp?.data?.models ?? [];
}

export async function switchModel(
  modelName: string,
  options?: { initLlm?: boolean; lmModelPath?: string; slot?: number },
): Promise<string> {
  const resp = await fetchAPI<{ data?: { message?: string } }>('/v1/init', {
    model: modelName,
    slot: options?.slot ?? 1,
    init_llm: options?.initLlm ?? true,
    lm_model_path: options?.lmModelPath,
  });
  return resp?.data?.message || 'Model loaded';
}

export async function getModels(): Promise<unknown> {
  return fetchAPI('/v1/models');
}

export async function getStats(): Promise<unknown> {
  return fetchAPI('/v1/stats');
}

// ---------------------------------------------------------------------------
// LoRA management
// ---------------------------------------------------------------------------

export async function loadLora(loraPath: string, adapterName?: string): Promise<string> {
  const resp = await fetchAPI<{ data?: { message?: string } }>('/v1/lora/load', {
    lora_path: loraPath,
    adapter_name: adapterName,
  });
  return resp?.data?.message || 'LoRA loaded';
}

export async function unloadLora(): Promise<string> {
  const resp = await fetchAPI<{ data?: { message?: string } }>('/v1/lora/unload', {});
  return resp?.data?.message || 'LoRA unloaded';
}

export async function toggleLora(useLora: boolean): Promise<string> {
  const resp = await fetchAPI<{ data?: { message?: string } }>('/v1/lora/toggle', { use_lora: useLora });
  return resp?.data?.message || `LoRA ${useLora ? 'enabled' : 'disabled'}`;
}

export async function setLoraScale(scale: number, adapterName?: string): Promise<string> {
  const resp = await fetchAPI<{ data?: { message?: string } }>('/v1/lora/scale', {
    scale,
    adapter_name: adapterName,
  });
  return resp?.data?.message || `LoRA scale set to ${scale}`;
}

export async function getLoraStatus(): Promise<unknown> {
  return fetchAPI('/v1/lora/status');
}

/** POST /create_random_sample — a random style+lyrics-language starter for Simple mode. */
export async function getRandomSample(): Promise<{ description: string; instrumental: boolean; vocalLanguage: string }> {
  const resp = await fetchAPI<{ data?: Record<string, unknown> } | Record<string, unknown>>('/create_random_sample', {});
  const sample = ((resp as { data?: Record<string, unknown> })?.data ?? resp ?? {}) as Record<string, unknown>;
  return {
    description: String(sample.description ?? sample.caption ?? sample.prompt ?? ''),
    instrumental: Boolean(sample.instrumental ?? false),
    vocalLanguage: String(sample.vocal_language ?? 'unknown'),
  };
}

export interface FormatInputResult {
  caption: string;
  lyrics: string;
  bpm?: number;
  duration?: number;
  keyScale?: string;
  timeSignature?: string;
  vocalLanguage?: string;
}

/** POST /format_input — LLM-assisted style/lyrics cleanup + metadata extraction. */
export async function formatInput(input: {
  caption: string;
  lyrics?: string;
  temperature?: number;
  bpm?: number;
  duration?: number;
  keyScale?: string;
  timeSignature?: string;
}): Promise<FormatInputResult> {
  const paramObj: Record<string, unknown> = {};
  if (input.bpm && input.bpm > 0) paramObj.bpm = input.bpm;
  if (input.duration && input.duration > 0) paramObj.duration = input.duration;
  if (input.keyScale) paramObj.key = input.keyScale;
  if (input.timeSignature) paramObj.time_signature = input.timeSignature;

  const resp = await fetchAPI<{
    code?: number;
    error?: string;
    detail?: string;
    data?: {
      caption: string; lyrics: string; bpm?: number; duration?: number;
      key_scale?: string; time_signature?: string; vocal_language?: string;
    };
  }>('/format_input', {
    prompt: input.caption,
    lyrics: input.lyrics || '',
    temperature: input.temperature ?? 0.85,
    param_obj: paramObj,
  });

  if (resp.code !== undefined && resp.code !== 200) {
    throw new UpstreamUnavailableError(resp.error || resp.detail || 'ACE-Step /format_input failed');
  }
  const d = resp.data;
  if (!d) throw new UpstreamUnavailableError('ACE-Step /format_input returned no data');
  return {
    caption: d.caption,
    lyrics: d.lyrics,
    bpm: d.bpm,
    duration: d.duration,
    keyScale: d.key_scale,
    timeSignature: d.time_signature,
    vocalLanguage: d.vocal_language,
  };
}

export async function isACEStepAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${apiBase()}/health`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Training / dataset management. Ported from ace-step-ui's
// `server/src/routes/training.ts`'s inline `aceStepFetch` calls — pulled up
// here (rather than duplicated in `routes/ace/training.routes.ts`) per this
// module's role as the one ACE-Step FastAPI client. Every call in this
// section must run inside a `submitGpuJob('ace-train', ...)` callback (see
// `routes/ace/training.routes.ts`) so `ensureResident('ace-step')` has
// already spawned/held the FastAPI backend.
// ---------------------------------------------------------------------------

export interface DatasetLoadResult {
  status: string;
  dataframe: unknown | null;
  sampleCount: number;
  datasetName: string | null;
  samples: Array<Record<string, unknown>>;
}

/** POST /v1/dataset/load — parse ACE-Step's envelope into a flat shape. */
export async function loadDataset(datasetPath: string): Promise<DatasetLoadResult> {
  const resp = await fetchAPI<{
    data?: {
      message?: string; dataframe?: unknown; num_samples?: number;
      dataset_name?: string; samples?: Array<Record<string, unknown>>;
    };
  }>('/v1/dataset/load', { dataset_path: datasetPath });
  const d = resp?.data ?? {};
  const samples = Array.isArray(d.samples) ? d.samples : [];
  return {
    status: d.message || `Dataset loaded (${samples.length} samples)`,
    dataframe: d.dataframe ?? null,
    sampleCount: typeof d.num_samples === 'number' ? d.num_samples : samples.length,
    datasetName: d.dataset_name ?? null,
    samples,
  };
}

export interface PreprocessStartResult {
  taskId: string | undefined;
  status: string;
}

/** POST /v1/dataset/preprocess_async — starts ACE-Step's own background task. */
export async function preprocessDatasetAsync(
  datasetPath: string,
  outputDir: string,
): Promise<PreprocessStartResult> {
  const resp = await fetchAPI<{
    data?: { task_id?: string; message?: string; status?: string };
    task_id?: string; message?: string; status?: string;
  }>('/v1/dataset/preprocess_async', { dataset_path: datasetPath, output_dir: outputDir }, { timeoutMs: 30_000 });
  const d = resp?.data ?? resp ?? {};
  return { taskId: d.task_id, status: d.message || d.status || 'Preprocessing started' };
}

/** GET /v1/dataset/preprocess_status — raw passthrough; caller decides shape. */
export async function getPreprocessStatus(): Promise<Record<string, unknown>> {
  return fetchAPI<Record<string, unknown>>('/v1/dataset/preprocess_status');
}

export interface AutoLabelStartResult {
  taskId: string | undefined;
  total: number | undefined;
  status: string;
}

/** POST /v1/dataset/auto_label_async */
export async function autoLabelDatasetAsync(opts: {
  skipMetas?: boolean; formatLyrics?: boolean; transcribeLyrics?: boolean; onlyUnlabeled?: boolean;
}): Promise<AutoLabelStartResult> {
  const resp = await fetchAPI<{
    data?: { task_id?: string; total?: number; message?: string; status?: string };
    task_id?: string; total?: number; message?: string; status?: string;
  }>('/v1/dataset/auto_label_async', {
    skip_metas: opts.skipMetas ?? false,
    format_lyrics: opts.formatLyrics ?? false,
    transcribe_lyrics: opts.transcribeLyrics ?? false,
    only_unlabeled: opts.onlyUnlabeled ?? false,
  }, { timeoutMs: 30_000 });
  const d = resp?.data ?? resp ?? {};
  return { taskId: d.task_id, total: d.total, status: d.message || d.status || 'Auto-labeling started' };
}

/** GET /v1/dataset/auto_label_status — raw passthrough. */
export async function getAutoLabelStatus(): Promise<Record<string, unknown>> {
  return fetchAPI<Record<string, unknown>>('/v1/dataset/auto_label_status');
}

/** GET /v1/dataset/sample/:idx */
export async function getDatasetSample(idx: number): Promise<Record<string, unknown>> {
  const resp = await fetchAPI<{ data?: Record<string, unknown> } | Record<string, unknown>>(`/v1/dataset/sample/${idx}`);
  return ((resp as { data?: Record<string, unknown> })?.data ?? resp ?? {}) as Record<string, unknown>;
}

export interface SaveSampleInput {
  sampleIdx: number;
  caption: string;
  genre: string;
  promptOverride: string | null;
  lyrics: string;
  bpm: number | null;
  keyscale: string;
  timesignature: string;
  language: string;
  instrumental: boolean;
}

/** PUT /v1/dataset/sample/:idx */
export async function saveDatasetSample(input: SaveSampleInput): Promise<Record<string, unknown>> {
  return fetchAPI<Record<string, unknown>>(`/v1/dataset/sample/${input.sampleIdx}`, {
    sample_idx: input.sampleIdx,
    caption: input.caption,
    genre: input.genre,
    prompt_override: input.promptOverride,
    lyrics: input.lyrics,
    bpm: input.bpm,
    keyscale: input.keyscale,
    timesignature: input.timesignature,
    language: input.language,
    is_instrumental: input.instrumental,
  }, { method: 'PUT' });
}

export interface InitTrainingModelResult {
  status: string;
  modelReady: boolean;
}

/**
 * POST /v1/init for the training panel's model picker. Distinct from
 * `switchModel` above (used by the generation model-switch UI) because the
 * training panel's response shape surfaces `model_ready` and reads fields at
 * the top level in ace-step-ui's original call — this checks both the
 * top-level and `data`-wrapped shape defensively since the two ace-step-ui
 * call sites disagreed on which the FastAPI actually returns.
 */
export async function initModelForTraining(opts: {
  checkpoint?: string; initLlm?: boolean; lmModelPath?: string;
}): Promise<InitTrainingModelResult> {
  const resp = await fetchAPI<{
    data?: { status?: string; message?: string; model_ready?: boolean };
    status?: string; message?: string; model_ready?: boolean;
  }>('/v1/init', {
    model: opts.checkpoint ?? '',
    init_llm: opts.initLlm ?? false,
    lm_model_path: opts.lmModelPath ?? '',
  }, { timeoutMs: 300_000 });
  const d = resp?.data ?? resp ?? {};
  return { status: d.status || d.message || 'Model initialized', modelReady: d.model_ready ?? true };
}

/** POST /v1/reinitialize — force-reload model weights (e.g. after
 *  ACESTEP_NO_INIT lazy boot). */
export async function reinitializeModel(): Promise<void> {
  await fetchAPI('/v1/reinitialize', {}, { timeoutMs: 300_000 });
}

export interface StartTrainingInput {
  tensorDir: string;
  rank: number;
  alpha: number;
  dropout: number;
  learningRate: number;
  epochs: number;
  batchSize: number;
  gradientAccumulation: number;
  saveEvery: number;
  shift: number;
  seed: number;
  outputDir: string;
  resumeCheckpoint?: string | null;
}

/**
 * POST /v1/training/start. CRITICAL: every key here must match the FastAPI
 * `StartTrainingRequest` pydantic field names exactly — pydantic silently
 * drops unknown fields and falls back to its own defaults (ace-step-ui hit
 * this: it trained at `train_epochs=10` when the UI said 3000, and
 * `lora_rank=64` when the UI requested 128, before the field names were
 * fixed). Field reference: `acestep/api/train_api_models.py`'s
 * `StartTrainingRequest` in the upstream ACE-Step-1.5 source.
 */
export async function startTraining(input: StartTrainingInput): Promise<Record<string, unknown>> {
  return fetchAPI<Record<string, unknown>>('/v1/training/start', {
    tensor_dir: input.tensorDir,
    lora_rank: input.rank,
    lora_alpha: input.alpha,
    lora_dropout: input.dropout,
    learning_rate: input.learningRate,
    train_epochs: input.epochs,
    train_batch_size: input.batchSize,
    gradient_accumulation: input.gradientAccumulation,
    save_every_n_epochs: input.saveEvery,
    training_shift: input.shift,
    training_seed: input.seed,
    lora_output_dir: input.outputDir,
    resume_checkpoint: input.resumeCheckpoint ?? null,
  }, { timeoutMs: 300_000 });
}

/** GET /v1/training/status — raw passthrough; polled both by the client and
 *  by `routes/ace/training.routes.ts`'s background completion-watch loop. */
export async function getTrainingStatus(): Promise<Record<string, unknown>> {
  return fetchAPI<Record<string, unknown>>('/v1/training/status');
}

/** POST /v1/training/stop */
export async function stopTraining(): Promise<Record<string, unknown>> {
  return fetchAPI<Record<string, unknown>>('/v1/training/stop', {});
}
