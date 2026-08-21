// Typed API client for the ACE-Step music page (`pages/music/*`).
//
// Route specs are defined inline as typed constants — same pattern as
// `api/videoboard.ts` — rather than imported from the server route files
// (which bundle server-only deps). `server/src/routes/ace/{generate,songs,
// lyrics}.routes.ts` don't export a `xxxRoutes` spec object the way
// `catalog.contract.ts` does, so the specs below are the UI-side source of
// truth for path/method; the Zod schemas themselves are imported from the
// shared contract package so request/response shapes stay in lock-step with
// the server.

import { z } from 'zod';
import { apiCall } from '../api/client.js';
import { ApiClientError } from '../api/error.js';
import { aceEvents } from './aceEvents.js';
import { isWsConnected } from './wsStatus.js';
import {
  GenerationParamsSchema,
  GenerateSubmitResponseSchema,
  AnalyzeBodySchema,
  AnalyzeResponseSchema,
  StemsBodySchema,
  StemsResponseSchema,
  GenerationStatusParamsSchema,
  GenerationStatusResponseSchema,
  GenerationCancelParamsSchema,
  GenerationCancelResponseSchema,
  ModelsListResponseSchema,
  SimpleGenerateBodySchema,
  SimpleGenerateResponseSchema,
  RandomDescriptionQuerySchema,
  RandomDescriptionResponseSchema,
  FormatBodySchema,
  FormatResponseSchema,
  UploadAudioResponseSchema,
  GpuStatusResponseSchema,
  AutoUnloadBodySchema,
} from '@server/contracts/ace/generate.contract';
import {
  SongSchema,
  SongListQuerySchema,
  SongListResponseSchema,
  SongParamsSchema,
  SongGetResponseSchema,
  SongUpdateBodySchema,
  SongFavoriteBodySchema,
  SongDeleteResponseSchema,
  PlaylistListResponseSchema,
  PlaylistCreateBodySchema,
  PlaylistGetResponseSchema,
  PlaylistParamsSchema,
  PlaylistAddSongBodySchema,
  PlaylistSongParamsSchema,
} from '@server/contracts/ace/songs.contract';
import {
  LyricsGenerateBodySchema,
  LyricsGenerateResponseSchema,
} from '@server/contracts/ace/lyrics.contract';
import {
  TranscribeUploadsBodySchema,
  TranscribeUploadsResponseSchema,
  TranscribeUploadsStatusQuerySchema,
  TranscribeUploadsStatusResponseSchema,
  BuildDatasetBodySchema,
  BuildDatasetResponseSchema,
  PreprocessBodySchema,
  PreprocessResponseSchema,
  PreprocessStatusResponseSchema,
  AutoLabelBodySchema,
  AutoLabelResponseSchema,
  AutoLabelStatusResponseSchema,
  InitModelBodySchema,
  InitModelResponseSchema,
  CheckpointsListResponseSchema,
  LoraCheckpointsQuerySchema,
  LoraCheckpointsResponseSchema,
  LoadDatasetBodySchema,
  LoadDatasetResponseSchema,
  SamplePreviewQuerySchema,
  SamplePreviewResponseSchema,
  SaveSampleBodySchema,
  SaveSampleResponseSchema,
  StartTrainingBodySchema,
  StartTrainingResponseSchema,
  TrainingStatusResponseSchema,
  StopTrainingResponseSchema,
  PreprocessStemsBodySchema,
  PreprocessStemsResponseSchema,
  PreprocessStemsStatusQuerySchema,
  PreprocessStemsStatusResponseSchema,
  TrainingLimitsResponseSchema,
  UploadTrainingAudioResponseSchema,
} from '@server/contracts/ace/training.contract';
import {
  TtsStatusParamsSchema,
  TtsStatusResponseSchema,
} from '@server/contracts/ace/tts.contract';
import {
  LoraLoadBodySchema,
  LoraLoadResponseSchema,
  LoraUnloadResponseSchema,
  LoraScaleBodySchema,
  LoraScaleResponseSchema,
  LoraToggleBodySchema,
  LoraToggleResponseSchema,
  LoraStatusResponseSchema,
} from '@server/contracts/ace/lora.contract';
import type {
  GenerationParams,
  GenerateSubmitResponse,
  GenerationStatusResponse,
  AceModelInfo,
  SimpleGenerateResult,
  RandomDescriptionResult,
  FormatResult,
  Song,
  SongListQuery,
  SongUpdateBody,
  Playlist,
  LyricsGenerateBody,
  DatasetBuildResult,
  UploadTrainingAudioResult,
  BuildDatasetBody,
  PreprocessBody,
  AutoLabelBody,
  InitModelBody,
  SaveSampleBody,
  StartTrainingBody,
  StartTrainingResult,
  PreprocessStemsBody,
  PreprocessStemsResult,
  PreprocessStemsStatus,
  TrainingLimits,
  TrainingSample,
  TtsStatus,
  TtsCloneBody,
  LoraLoadResult,
  LoraStatus,
} from '../types/ace';

export type { Song, Playlist, GenerationParams, GenerationStatusResponse } from '../types/ace';

// ---------------------------------------------------------------------------
// Route specs
// ---------------------------------------------------------------------------

const submitSpec = {
  method: 'POST',
  path: '/ace/generate',
  body: GenerationParamsSchema,
  response: GenerateSubmitResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
} as const;

const analyzeSpec = {
  method: 'POST',
  path: '/ace/analyze',
  body: AnalyzeBodySchema,
  response: AnalyzeResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
} as const;

const stemsSpec = {
  method: 'POST',
  path: '/ace/stems',
  body: StemsBodySchema,
  response: StemsResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
} as const;

const statusSpec = {
  method: 'GET',
  path: '/ace/generate/status/:jobId',
  params: GenerationStatusParamsSchema,
  response: GenerationStatusResponseSchema,
  auth: { required: true, scopes: ['system:read'] },
} as const;

const cancelSpec = {
  method: 'POST',
  path: '/ace/generate/cancel/:jobId',
  params: GenerationCancelParamsSchema,
  response: GenerationCancelResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
} as const;

const modelsSpec = {
  method: 'GET',
  path: '/ace/generate/models',
  response: ModelsListResponseSchema,
  auth: { required: true, scopes: ['system:read'] },
} as const;

const simpleSpec = {
  method: 'POST',
  path: '/ace/generate/simple',
  body: SimpleGenerateBodySchema,
  response: SimpleGenerateResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
} as const;

const randomDescriptionSpec = {
  method: 'GET',
  path: '/ace/generate/random-description',
  query: RandomDescriptionQuerySchema,
  response: RandomDescriptionResponseSchema,
  auth: { required: true, scopes: ['system:read'] },
} as const;

const formatSpec = {
  method: 'POST',
  path: '/ace/generate/format',
  body: FormatBodySchema,
  response: FormatResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
} as const;

const gpuStatusSpec = {
  method: 'GET',
  path: '/ace/generate/gpu/status',
  response: GpuStatusResponseSchema,
  auth: { required: true, scopes: ['system:read'] },
} as const;

const autoUnloadSpec = {
  method: 'POST',
  path: '/ace/generate/gpu/auto-unload',
  body: AutoUnloadBodySchema,
  response: GpuStatusResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
} as const;

const songListSpec = {
  method: 'GET',
  path: '/ace/songs',
  query: SongListQuerySchema,
  response: SongListResponseSchema,
  auth: { required: true, scopes: ['gallery:read'] },
} as const;

const songGetSpec = {
  method: 'GET',
  path: '/ace/songs/:id',
  params: SongParamsSchema,
  response: SongGetResponseSchema,
  auth: { required: true, scopes: ['gallery:read'] },
} as const;

const songUpdateSpec = {
  method: 'PATCH',
  path: '/ace/songs/:id',
  params: SongParamsSchema,
  body: SongUpdateBodySchema,
  response: SongGetResponseSchema,
  auth: { required: true, scopes: ['gallery:write'] },
} as const;

const songFavoriteSpec = {
  method: 'POST',
  path: '/ace/songs/:id/favorite',
  params: SongParamsSchema,
  body: SongFavoriteBodySchema,
  response: SongGetResponseSchema,
  auth: { required: true, scopes: ['gallery:write'] },
} as const;

const songDeleteSpec = {
  method: 'DELETE',
  path: '/ace/songs/:id',
  params: SongParamsSchema,
  response: SongDeleteResponseSchema,
  auth: { required: true, scopes: ['gallery:delete'] },
} as const;

const playlistListSpec = {
  method: 'GET',
  path: '/ace/playlists',
  response: PlaylistListResponseSchema,
  auth: { required: true, scopes: ['gallery:read'] },
} as const;

const playlistCreateSpec = {
  method: 'POST',
  path: '/ace/playlists',
  body: PlaylistCreateBodySchema,
  response: PlaylistGetResponseSchema,
  auth: { required: true, scopes: ['gallery:write'] },
} as const;

const playlistGetSpec = {
  method: 'GET',
  path: '/ace/playlists/:id',
  params: PlaylistParamsSchema,
  response: PlaylistGetResponseSchema,
  auth: { required: true, scopes: ['gallery:read'] },
} as const;

const playlistDeleteSpec = {
  method: 'DELETE',
  path: '/ace/playlists/:id',
  params: PlaylistParamsSchema,
  response: SongDeleteResponseSchema,
  auth: { required: true, scopes: ['gallery:delete'] },
} as const;

const playlistAddSongSpec = {
  method: 'POST',
  path: '/ace/playlists/:id/songs',
  params: PlaylistParamsSchema,
  body: PlaylistAddSongBodySchema,
  response: PlaylistGetResponseSchema,
  auth: { required: true, scopes: ['gallery:write'] },
} as const;

const playlistRemoveSongSpec = {
  method: 'DELETE',
  path: '/ace/playlists/:id/songs/:songId',
  params: PlaylistSongParamsSchema,
  response: PlaylistGetResponseSchema,
  auth: { required: true, scopes: ['gallery:write'] },
} as const;

const lyricsGenerateSpec = {
  method: 'POST',
  path: '/ace/lyrics/generate',
  body: LyricsGenerateBodySchema,
  response: LyricsGenerateResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
} as const;

// ---- Training -----------------------------------------------------------

const transcribeUploadsSpec = {
  method: 'POST',
  path: '/ace/training/transcribe-uploads',
  body: TranscribeUploadsBodySchema,
  response: TranscribeUploadsResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
} as const;

const transcribeUploadsStatusSpec = {
  method: 'GET',
  path: '/ace/training/transcribe-uploads-status',
  query: TranscribeUploadsStatusQuerySchema,
  response: TranscribeUploadsStatusResponseSchema,
  auth: { required: true, scopes: ['system:read'] },
} as const;

const buildDatasetSpec = {
  method: 'POST',
  path: '/ace/training/build-dataset',
  body: BuildDatasetBodySchema,
  response: BuildDatasetResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
} as const;

const preprocessSpec = {
  method: 'POST',
  path: '/ace/training/preprocess',
  body: PreprocessBodySchema,
  response: PreprocessResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
} as const;

const preprocessStatusSpec = {
  method: 'GET',
  path: '/ace/training/preprocess-status',
  response: PreprocessStatusResponseSchema,
  auth: { required: true, scopes: ['system:read'] },
} as const;

const autoLabelSpec = {
  method: 'POST',
  path: '/ace/training/auto-label',
  body: AutoLabelBodySchema,
  response: AutoLabelResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
} as const;

const autoLabelStatusSpec = {
  method: 'GET',
  path: '/ace/training/auto-label-status',
  response: AutoLabelStatusResponseSchema,
  auth: { required: true, scopes: ['system:read'] },
} as const;

const initModelSpec = {
  method: 'POST',
  path: '/ace/training/init-model',
  body: InitModelBodySchema,
  response: InitModelResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
} as const;

const checkpointsSpec = {
  method: 'GET',
  path: '/ace/training/checkpoints',
  response: CheckpointsListResponseSchema,
  auth: { required: true, scopes: ['system:read'] },
} as const;

const loraCheckpointsSpec = {
  method: 'GET',
  path: '/ace/training/lora-checkpoints',
  query: LoraCheckpointsQuerySchema,
  response: LoraCheckpointsResponseSchema,
  auth: { required: true, scopes: ['system:read'] },
} as const;

const loadDatasetSpec = {
  method: 'POST',
  path: '/ace/training/load-dataset',
  body: LoadDatasetBodySchema,
  response: LoadDatasetResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
} as const;

const samplePreviewSpec = {
  method: 'GET',
  path: '/ace/training/sample-preview',
  query: SamplePreviewQuerySchema,
  response: SamplePreviewResponseSchema,
  auth: { required: true, scopes: ['system:read'] },
} as const;

const saveSampleSpec = {
  method: 'POST',
  path: '/ace/training/save-sample',
  body: SaveSampleBodySchema,
  response: SaveSampleResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
} as const;

const startTrainingSpec = {
  method: 'POST',
  path: '/ace/training/start',
  body: StartTrainingBodySchema,
  response: StartTrainingResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
} as const;

const trainingStatusSpec = {
  method: 'GET',
  path: '/ace/training/training-status',
  response: TrainingStatusResponseSchema,
  auth: { required: true, scopes: ['system:read'] },
} as const;

const stopTrainingSpec = {
  method: 'POST',
  path: '/ace/training/stop',
  response: StopTrainingResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
} as const;

const preprocessStemsSpec = {
  method: 'POST',
  path: '/ace/training/preprocess-stems',
  body: PreprocessStemsBodySchema,
  response: PreprocessStemsResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
} as const;

const preprocessStemsStatusSpec = {
  method: 'GET',
  path: '/ace/training/preprocess-stems-status',
  query: PreprocessStemsStatusQuerySchema,
  response: PreprocessStemsStatusResponseSchema,
  auth: { required: true, scopes: ['system:read'] },
} as const;

const trainingLimitsSpec = {
  method: 'GET',
  path: '/ace/training/limits',
  response: TrainingLimitsResponseSchema,
  auth: { required: true, scopes: ['system:read'] },
} as const;

// ---- TTS ------------------------------------------------------------------

const ttsStatusSpec = {
  method: 'GET',
  path: '/ace/tts/status/:jobId',
  params: TtsStatusParamsSchema,
  response: TtsStatusResponseSchema,
  auth: { required: true, scopes: ['system:read'] },
} as const;

// ---- LoRA control -----------------------------------------------------------

const loraLoadSpec = {
  method: 'POST',
  path: '/ace/lora/load',
  body: LoraLoadBodySchema,
  response: LoraLoadResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
} as const;

const loraUnloadSpec = {
  method: 'POST',
  path: '/ace/lora/unload',
  response: LoraUnloadResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
} as const;

const loraScaleSpec = {
  method: 'POST',
  path: '/ace/lora/scale',
  body: LoraScaleBodySchema,
  response: LoraScaleResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
} as const;

const loraToggleSpec = {
  method: 'POST',
  path: '/ace/lora/toggle',
  body: LoraToggleBodySchema,
  response: LoraToggleResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
} as const;

const loraStatusSpec = {
  method: 'GET',
  path: '/ace/lora/status',
  response: LoraStatusResponseSchema,
  auth: { required: true, scopes: ['system:read'] },
} as const;

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/** Default params shared by every submit — callers spread over this. */
export function defaultGenerationParams(): GenerationParams {
  return {
    customMode: true,
    lyrics: '',
    style: '',
    title: '',
    instrumental: false,
    audioFormat: 'mp3',
  };
}

// No cast: `GenerationParams` IS the contract's inferred type now, so a
// mismatch is a compile error instead of a silently-dropped request key.
export const submitGeneration = (params: GenerationParams): Promise<GenerateSubmitResponse> =>
  apiCall(submitSpec, { body: params });

/** Capture a track's style as ACE-Step audio codes. Synchronous — resolves
 *  with the codes rather than a job id, since there's no audio to wait for. */
export const analyzeAudio = (
  sourceAudioUrl: string,
  ditModel?: string,
): Promise<{
  audioCodes: string;
  codeCount: number;
  bpm?: number;
  keyScale?: string;
  timeSignature?: string;
  duration?: number;
  genre?: string;
  caption?: string;
  lyrics?: string;
  language?: string;
}> =>
  apiCall(analyzeSpec, { body: { sourceAudioUrl, ditModel } });

/** Real stem separation (Roformer/Demucs) — isolates what's in the recording,
 *  unlike the model's generative `extract` task. Slow: minutes, not seconds. */
export const separateStems = (
  sourceAudioUrl: string,
  model?: string,
): Promise<{ stems: { name: string; url: string }[] }> =>
  apiCall(stemsSpec, { body: { sourceAudioUrl, model } });

export const getGenerationStatus = (jobId: string): Promise<GenerationStatusResponse> =>
  apiCall(statusSpec, { params: { jobId } });

/** Cancel a queued or running generation job. Queued jobs never occupy a GPU
 *  slot; running jobs stop being tracked (ACE-Step itself has no cancel/stop
 *  endpoint for a generation task — see the server-side comment above
 *  `pollUntilTerminal` in `routes/ace/generate.routes.ts` — so the GPU keeps
 *  computing, comfy just stops waiting on the result). The server marks the
 *  job `cancelled` and pushes that over the same `ace:generation` WS channel
 *  `pollGenerationStatus` already subscribes to. */
export const cancelGeneration = (jobId: string): Promise<{ jobId: string; cancelled: boolean }> =>
  apiCall(cancelSpec, { params: { jobId } });

export const listModels = (): Promise<AceModelInfo[]> =>
  apiCall(modelsSpec, {}).then((r) => r.models);

export const simpleGenerate = (body: {
  description?: string;
  genre?: string;
  instrumental?: boolean;
}): Promise<SimpleGenerateResult> => apiCall(simpleSpec, { body });

export const randomDescription = (lang?: string): Promise<RandomDescriptionResult> =>
  apiCall(randomDescriptionSpec, { query: lang ? { lang } : {} });

export const formatInput = (body: {
  caption: string;
  lyrics?: string;
  bpm?: number;
  duration?: number;
  keyScale?: string;
  timeSignature?: string;
  temperature?: number;
}): Promise<FormatResult> => apiCall(formatSpec, { body });

/** ACE-Step GPU residency status — is the FastAPI backend running, how long
 *  has it been idle, and what's the configured idle-unload timeout.
 *  Mirrors server's `GpuStatusResponseSchema`. */
export interface AceStepGpuStatus {
  running: boolean;
  tenant: 'ollama' | 'comfy' | 'ace-step' | 'oneshot' | 'none';
  idleMinutes: number | null;
  timeoutMinutes: number | null;
}

export const getAceStepGpuStatus = (): Promise<AceStepGpuStatus> =>
  apiCall(gpuStatusSpec, {});

/** Set (or clear, via `minutes: null`) the ACE-Step idle-unload timeout. `0`
 *  disables idle-eviction entirely. */
export const setAceStepAutoUnload = (minutes: number | null): Promise<AceStepGpuStatus> =>
  apiCall(autoUnloadSpec, { body: { minutes } });

/** Track a generation job until it reaches a terminal state (succeeded/
 *  failed), or the caller aborts via the returned `cancel()`.
 *
 * The server pushes `{type:'ace:generation', data}` over the shared WS on
 * every status change (`routes/ace/generate.routes.ts`) — this subscribes to
 * that instead of polling `GET /ace/generate/status/:jobId` on a fixed
 * interval. The REST endpoint is still used once immediately
 * (reconciliation — covers state the caller doesn't have yet, e.g. right
 * after a page reload) and as a fallback poll while the socket is down/
 * reconnecting (`isWsConnected()`), so a dropped connection degrades to the
 * old polling behaviour rather than hanging. `onUpdate` fires on every
 * update (push or poll) so the UI can render queue position / progress /
 * stage; callers must call `cancel()` on unmount so an abandoned job's
 * updates don't keep firing toasts / auto-playing audio after the caller
 * has moved on. */
export function pollGenerationStatus(
  jobId: string,
  onUpdate: (status: GenerationStatusResponse) => void,
  opts: { intervalMs?: number } = {},
): { cancel: () => void } {
  const intervalMs = opts.intervalMs ?? 2000;
  let cancelled = false;
  let done = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const finish = (status: GenerationStatusResponse): void => {
    if (cancelled || done) return;
    done = true;
    onUpdate(status);
  };

  const isTerminal = (status: GenerationStatusResponse): boolean =>
    status.status === 'succeeded' || status.status === 'failed' || status.status === 'cancelled';

  const fetchOnce = async (): Promise<void> => {
    if (cancelled || done) return;
    try {
      const status = await getGenerationStatus(jobId);
      if (cancelled || done) return;
      if (isTerminal(status)) {
        finish(status);
      } else {
        onUpdate(status);
      }
    } catch (err) {
      if (cancelled || done) return;
      // A real 404 (job gone) is terminal — anything else is a transient
      // network hiccup the fallback loop below will retry.
      if (err instanceof ApiClientError && err.status === 404) {
        finish({ jobId, status: 'failed', error: 'Job not found' });
      }
    }
  };

  // Reconciliation — always fetch once immediately, regardless of socket
  // state, so a caller that just attached (fresh submit, or resuming
  // tracking after a page reload) sees current state without waiting for
  // the next push.
  void fetchOnce();

  const unsubscribe = aceEvents.onGeneration((status) => {
    if (cancelled || done || status.jobId !== jobId) return;
    if (isTerminal(status)) {
      finish(status);
    } else {
      onUpdate(status);
    }
  });

  // Fallback poll — only does real work while the shared WS is down; once it
  // reconnects, push takes back over and this loop just idles until unmount.
  const scheduleFallback = (): void => {
    if (cancelled || done) return;
    timer = setTimeout(() => {
      if (cancelled || done) return;
      if (!isWsConnected()) void fetchOnce();
      scheduleFallback();
    }, intervalMs);
  };
  scheduleFallback();

  return {
    cancel: () => {
      cancelled = true;
      unsubscribe();
      if (timer) clearTimeout(timer);
    },
  };
}

/** Upload a reference/source audio file for cover / audio2audio generation.
 *  Not wired into the Create tab yet (cover mode is deferred) — kept here so
 *  a follow-up agent can drive it straight from the typed client. Multipart,
 *  so it bypasses `apiCall` the same way `api/upload.ts#uploadFile` does. */
export async function uploadReferenceAudio(file: File): Promise<{ url: string; key: string }> {
  const form = new FormData();
  form.append('audio', file);
  const res = await fetch('/api/ace/generate/upload-audio', { method: 'POST', body: form });
  let body: unknown = null;
  try { body = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) {
    const e = body && typeof body === 'object' && 'error' in body
      ? (body as { error: { code?: string; message?: string } }).error
      : null;
    throw new ApiClientError({
      code: (e?.code as never) ?? 'upstream_unavailable',
      status: res.status,
      message: e?.message ?? `Upload failed: ${res.status}`,
    });
  }
  const parsed = UploadAudioResponseSchema.safeParse((body as { data?: unknown })?.data);
  if (!parsed.success) throw new Error('Upload response failed schema validation');
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Songs
// ---------------------------------------------------------------------------

export const listSongs = (query: SongListQuery = {}): Promise<Song[]> =>
  apiCall(songListSpec, {
    query: {
      favorite: query.favorite === undefined ? undefined : (query.favorite ? 'true' : 'false'),
      limit: query.limit,
      offset: query.offset,
    },
  }).then((r) => r.songs as Song[]);

export const getSong = (id: string): Promise<Song> =>
  apiCall(songGetSpec, { params: { id } }).then((r) => r.song as Song);

export const updateSong = (id: string, body: SongUpdateBody): Promise<Song> =>
  apiCall(songUpdateSpec, { params: { id }, body }).then((r) => r.song as Song);

export const setSongFavorite = (id: string, favorite: boolean): Promise<Song> =>
  apiCall(songFavoriteSpec, { params: { id }, body: { favorite } }).then((r) => r.song as Song);

export const deleteSong = (id: string): Promise<boolean> =>
  apiCall(songDeleteSpec, { params: { id } }).then((r) => r.success);

// ---------------------------------------------------------------------------
// Playlists
// ---------------------------------------------------------------------------

export const listPlaylists = (): Promise<Playlist[]> =>
  apiCall(playlistListSpec, {}).then((r) => r.playlists);

export const createPlaylist = (name: string, description?: string): Promise<{ playlist: Playlist; songs: Song[] }> =>
  apiCall(playlistCreateSpec, { body: { name, description } }).then((r) => ({ playlist: r.playlist, songs: r.songs as Song[] }));

export const getPlaylist = (id: string): Promise<{ playlist: Playlist; songs: Song[] }> =>
  apiCall(playlistGetSpec, { params: { id } }).then((r) => ({ playlist: r.playlist, songs: r.songs as Song[] }));

export const deletePlaylist = (id: string): Promise<boolean> =>
  apiCall(playlistDeleteSpec, { params: { id } }).then((r) => r.success);

export const addSongToPlaylist = (id: string, songId: string, position?: number): Promise<{ playlist: Playlist; songs: Song[] }> =>
  apiCall(playlistAddSongSpec, { params: { id }, body: { songId, position } }).then((r) => ({ playlist: r.playlist, songs: r.songs as Song[] }));

export const removeSongFromPlaylist = (id: string, songId: string): Promise<{ playlist: Playlist; songs: Song[] }> =>
  apiCall(playlistRemoveSongSpec, { params: { id, songId } }).then((r) => ({ playlist: r.playlist, songs: r.songs as Song[] }));

// ---------------------------------------------------------------------------
// Lyrics
// ---------------------------------------------------------------------------

export const generateLyrics = (body: LyricsGenerateBody): Promise<string> =>
  apiCall(lyricsGenerateSpec, { body }).then((r) => r.lyrics);

// ---------------------------------------------------------------------------
// Training (LoRA / voice-clone dataset + training pipeline)
// ---------------------------------------------------------------------------

/** Upload raw training audio files for `datasetName`. Multipart, so — same as
 *  `uploadReferenceAudio` above — this bypasses `apiCall` and hits the route
 *  directly; `uploadAudioSpec` on the server is registered for OpenAPI/audit
 *  only. */
export async function uploadTrainingAudio(files: File[], datasetName: string): Promise<UploadTrainingAudioResult> {
  const form = new FormData();
  form.append('datasetName', datasetName);
  for (const f of files) form.append('audio', f);
  const res = await fetch('/api/ace/training/upload-audio', { method: 'POST', body: form });
  let body: unknown = null;
  try { body = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) {
    const e = body && typeof body === 'object' && 'error' in body
      ? (body as { error: { code?: string; message?: string } }).error
      : null;
    throw new ApiClientError({
      code: (e?.code as never) ?? 'upstream_unavailable',
      status: res.status,
      message: e?.message ?? `Upload failed: ${res.status}`,
    });
  }
  const parsed = UploadTrainingAudioResponseSchema.safeParse((body as { data?: unknown })?.data);
  if (!parsed.success) throw new Error('Upload response failed schema validation');
  return parsed.data;
}

export const transcribeUploads = (datasetName: string): Promise<{ status: string; dir: string }> =>
  apiCall(transcribeUploadsSpec, { body: { datasetName } });

export type TranscribeStatus = {
  status: 'idle' | 'running' | 'succeeded' | 'failed';
  dir?: string;
  error?: string;
  lines: string[];
};

export const getTranscribeStatus = (datasetName: string): Promise<TranscribeStatus> =>
  apiCall(transcribeUploadsStatusSpec, { query: { datasetName } }) as Promise<TranscribeStatus>;

/** Poll batch Whisper transcription until it reaches a terminal state.
 *  `transcribeUploads` only registers the job now (it used to block for the
 *  whole run and 504 behind a proxy), so callers must poll this to know when
 *  the .txt sidecars are actually on disk. Mirrors `pollTtsStatus`. */
export function pollTranscribeStatus(
  datasetName: string,
  onUpdate: (status: TranscribeStatus) => void,
  opts: { intervalMs?: number } = {},
): { cancel: () => void } {
  const intervalMs = opts.intervalMs ?? 2000;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async (): Promise<void> => {
    if (cancelled) return;
    try {
      const status = await getTranscribeStatus(datasetName);
      if (cancelled) return;
      onUpdate(status);
      // 'idle' is terminal too: the server has no record of this job — it
      // finished and aged out of the in-process map, or the server restarted.
      // Either way there is nothing left to wait for, and treating it as
      // non-terminal would poll forever.
      if (status.status === 'succeeded' || status.status === 'failed' || status.status === 'idle') {
        return;
      }
    } catch {
      if (cancelled) return;
    }
    timer = setTimeout(() => { void tick(); }, intervalMs);
  };
  void tick();

  return { cancel: () => { cancelled = true; if (timer) clearTimeout(timer); } };
}

export const buildDataset = (body: BuildDatasetBody): Promise<DatasetBuildResult> =>
  apiCall(buildDatasetSpec, {
    body: {
      datasetName: body.datasetName,
      customTag: body.customTag ?? '',
      tagPosition: body.tagPosition ?? 'prepend',
      allInstrumental: body.allInstrumental ?? true,
    },
  }) as Promise<DatasetBuildResult>;

export const loadDataset = (datasetPath: string): Promise<DatasetBuildResult> =>
  apiCall(loadDatasetSpec, { body: { datasetPath } }) as Promise<DatasetBuildResult>;

export const startPreprocess = (body: PreprocessBody): Promise<{ task_id?: string; status: string }> =>
  apiCall(preprocessSpec, { body });

export const getPreprocessStatus = (): Promise<Record<string, unknown>> =>
  apiCall(preprocessStatusSpec, {});

export const startAutoLabel = (body: AutoLabelBody): Promise<{ task_id?: string; total?: number; status: string }> =>
  apiCall(autoLabelSpec, {
    body: {
      skipMetas: body.skipMetas ?? false,
      formatLyrics: body.formatLyrics ?? false,
      transcribeLyrics: body.transcribeLyrics ?? false,
      onlyUnlabeled: body.onlyUnlabeled ?? false,
    },
  });

export const getAutoLabelStatus = (): Promise<Record<string, unknown>> =>
  apiCall(autoLabelStatusSpec, {});

export const initTrainingModel = (body: InitModelBody = {}): Promise<{ status: string; modelReady: boolean }> =>
  apiCall(initModelSpec, {
    body: {
      checkpoint: body.checkpoint ?? '',
      initLlm: body.initLlm ?? false,
      lmModelPath: body.lmModelPath ?? '',
      reinitialize: body.reinitialize ?? false,
    },
  });

export const listTrainingCheckpoints = (): Promise<{ checkpoints: string[]; configs: string[] }> =>
  apiCall(checkpointsSpec, {});

/** Lists trained LoRA adapters under the training output dir (the fixed
 *  `.../final/adapter` layout) — this is the persona/LoRA picker's data
 *  source, both here and in `CreateTab`'s persona select. */
export const listLoraCheckpoints = (dir?: string): Promise<{ checkpoints: string[]; outputDir?: string }> =>
  apiCall(loraCheckpointsSpec, { query: dir ? { dir } : {} });

export const getSamplePreview = (idx: number): Promise<TrainingSample> =>
  apiCall(samplePreviewSpec, { query: { idx } }) as Promise<TrainingSample>;

export const saveSample = (body: SaveSampleBody): Promise<Record<string, unknown>> =>
  apiCall(saveSampleSpec, {
    body: {
      sampleIdx: body.sampleIdx,
      caption: body.caption ?? '',
      genre: body.genre ?? '',
      promptOverride: body.promptOverride ?? null,
      lyrics: body.lyrics ?? '',
      bpm: body.bpm ?? null,
      key: body.key ?? '',
      timeSignature: body.timeSignature ?? '',
      language: body.language ?? 'instrumental',
      instrumental: body.instrumental ?? true,
    },
  });

export const startTraining = (body: StartTrainingBody): Promise<StartTrainingResult> =>
  apiCall(startTrainingSpec, {
    body: {
      datasetName: body.datasetName,
      tensorDir: body.tensorDir,
      rank: body.rank ?? 64,
      alpha: body.alpha ?? 128,
      dropout: body.dropout ?? 0.1,
      learningRate: body.learningRate ?? 0.0003,
      epochs: body.epochs ?? 1000,
      batchSize: body.batchSize ?? 1,
      gradientAccumulation: body.gradientAccumulation ?? 1,
      saveEvery: body.saveEvery ?? 200,
      shift: body.shift ?? 3.0,
      seed: body.seed ?? 42,
      outputDir: body.outputDir,
      resumeCheckpoint: body.resumeCheckpoint ?? null,
    },
  });

export const getTrainingStatus = (): Promise<Record<string, unknown>> =>
  apiCall(trainingStatusSpec, {});

export const stopTraining = (): Promise<Record<string, unknown>> =>
  apiCall(stopTrainingSpec, {});

export const preprocessStems = (body: PreprocessStemsBody): Promise<PreprocessStemsResult> =>
  apiCall(preprocessStemsSpec, {
    body: {
      datasetName: body.datasetName,
      category: body.category,
      subType: body.subType ?? null,
      preprocessing: body.preprocessing,
    },
  }) as Promise<PreprocessStemsResult>;

export const getPreprocessStemsStatus = (jobId: string): Promise<PreprocessStemsStatus> =>
  apiCall(preprocessStemsStatusSpec, { query: { jobId } }) as Promise<PreprocessStemsStatus>;

export const getTrainingLimits = (): Promise<TrainingLimits> =>
  apiCall(trainingLimitsSpec, {});

/** Build the training-audio preview URL for a sample's `audio` path (an
 *  absolute filesystem path the server hands back — there's no dedicated
 *  streaming route for it in this pack, so playback in the sample editor is
 *  best-effort and may 404 until a follow-up wires one up). Kept as a named
 *  helper so call sites don't inline the assumption. */
export function trainingSampleAudioSrc(_sample: Pick<TrainingSample, 'audio'>): string | null {
  // No `GET /ace/training/audio` proxy exists in this pack (see the TODO at
  // the bottom of `routes/ace/training.routes.ts`) — sample audio preview in
  // the Train tab is therefore not wired to a playable URL yet.
  return null;
}

// ---------------------------------------------------------------------------
// TTS (voice-clone speech synthesis via IndexTTS2)
// ---------------------------------------------------------------------------

/** Submit a voice-clone TTS job. Multipart (reference + optional emotion
 *  audio), so this bypasses `apiCall` the same way `uploadReferenceAudio` /
 *  `uploadTrainingAudio` do. */
export async function submitTtsClone(body: TtsCloneBody): Promise<{ jobId: string }> {
  const form = new FormData();
  form.append('refAudio', body.refAudio);
  form.append('text', body.text);
  if (body.emoAudio) form.append('emoAudio', body.emoAudio);
  if (body.emoAlpha !== undefined) form.append('emoAlpha', String(body.emoAlpha));
  if (body.emoText) form.append('emoText', body.emoText);
  if (body.emoVector) form.append('emoVector', JSON.stringify(body.emoVector));
  if (body.fp16 !== undefined) form.append('fp16', String(body.fp16));
  if (body.seed !== undefined) form.append('seed', String(body.seed));
  if (body.intervalSilence !== undefined) form.append('intervalSilence', String(body.intervalSilence));

  const res = await fetch('/api/ace/tts/clone', { method: 'POST', body: form });
  let respBody: unknown = null;
  try { respBody = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) {
    const e = respBody && typeof respBody === 'object' && 'error' in respBody
      ? (respBody as { error: { code?: string; message?: string } }).error
      : null;
    throw new ApiClientError({
      code: (e?.code as never) ?? 'upstream_unavailable',
      status: res.status,
      message: e?.message ?? `TTS submit failed: ${res.status}`,
    });
  }
  const data = (respBody as { data?: { jobId?: string } })?.data;
  if (!data?.jobId) throw new Error('TTS clone response missing jobId');
  return { jobId: data.jobId };
}

export const getTtsStatus = (jobId: string): Promise<TtsStatus> =>
  apiCall(ttsStatusSpec, { params: { jobId } }) as Promise<TtsStatus>;

/** Track a voice-clone TTS job until it reaches a terminal state. Mirrors
 *  `pollGenerationStatus` above: subscribes to the WS push
 *  (`{type:'ace:tts', data}`, emitted by `services/ace/ttsJobs.ts` on every
 *  update) instead of polling `GET /ace/tts/status/:jobId` on a fixed
 *  interval, using that same REST endpoint once for reconciliation and as a
 *  fallback while the socket is down. Callers must call the returned
 *  `cancel()` on unmount. */
export function pollTtsStatus(
  jobId: string,
  onUpdate: (status: TtsStatus) => void,
  opts: { intervalMs?: number } = {},
): { cancel: () => void } {
  const intervalMs = opts.intervalMs ?? 1500;
  let cancelled = false;
  let done = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const finish = (status: TtsStatus): void => {
    if (cancelled || done) return;
    done = true;
    onUpdate(status);
  };

  const fetchOnce = async (): Promise<void> => {
    if (cancelled || done) return;
    try {
      const status = await getTtsStatus(jobId);
      if (cancelled || done) return;
      if (status.status === 'completed' || status.status === 'failed') {
        finish(status);
      } else {
        onUpdate(status);
      }
    } catch (err) {
      if (cancelled || done) return;
      if (err instanceof ApiClientError && err.status === 404) {
        finish({
          id: jobId, status: 'failed', progress: 0, log: [], error: 'Job not found',
          createdAt: Date.now(), updatedAt: Date.now(),
        });
      }
    }
  };

  void fetchOnce();

  const unsubscribe = aceEvents.onTts((status) => {
    if (cancelled || done || status.id !== jobId) return;
    if (status.status === 'completed' || status.status === 'failed') {
      finish(status);
    } else {
      onUpdate(status);
    }
  });

  const scheduleFallback = (): void => {
    if (cancelled || done) return;
    timer = setTimeout(() => {
      if (cancelled || done) return;
      if (!isWsConnected()) void fetchOnce();
      scheduleFallback();
    }, intervalMs);
  };
  scheduleFallback();

  return {
    cancel: () => {
      cancelled = true;
      unsubscribe();
      if (timer) clearTimeout(timer);
    },
  };
}

// ---------------------------------------------------------------------------
// LoRA control (load/unload/scale a trained adapter into the resident
// ACE-Step FastAPI ahead of a generation — this is how `CreateTab`'s
// persona picker activates a trained voice).
// ---------------------------------------------------------------------------

export const loadLora = (loraPath: string, adapterName?: string): Promise<LoraLoadResult> =>
  apiCall(loraLoadSpec, { body: { lora_path: loraPath, adapter_name: adapterName } });

export const unloadLora = (): Promise<{ message: string }> =>
  apiCall(loraUnloadSpec, {});

export const setLoraScale = (scale: number, adapterName?: string): Promise<{ message: string; scale: number }> =>
  apiCall(loraScaleSpec, { body: { scale, adapter_name: adapterName } });

export const toggleLora = (enabled: boolean): Promise<{ message: string; active: boolean }> =>
  apiCall(loraToggleSpec, { body: { enabled } });

export const getLoraStatus = (): Promise<LoraStatus> =>
  apiCall(loraStatusSpec, {});

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** `song.audioUrl` from the API is already a same-origin absolute path
 *  (`/api/ace/audio/output/<key>`) — this helper exists only so call sites
 *  don't sprinkle the raw string literal. */
export function songAudioSrc(song: Pick<Song, 'audioUrl'>): string | null {
  return song.audioUrl ?? null;
}

// Re-exported for callers that want to reference the Zod schema directly
// (e.g. a future settings/debug panel).
export { SongSchema };
