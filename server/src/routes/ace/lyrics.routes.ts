// ACE-Step lyrics-generation routes.
// GET  /api/ace/lyrics/models   — list the small GGUF lyrics-model catalog + on-disk status. Scope: system:read.
// POST /api/ace/lyrics/generate — generate lyrics from genre/topic/mood.      Scope: generate:write.
//
// GPU-scheduler decision: `data/ace/lyrics_generate.py` loads its GGUF model
// via llama-cpp-python with `n_gpu_layers=0` hardcoded (CPU-only inference —
// see the script). It never touches VRAM, so it does NOT contend with
// ACE-Step/ComfyUI/Ollama for the GPU slot and is deliberately NOT wrapped in
// `submitGpuJob`. If a future model swap moves this to GPU offload, add a
// `submitGpuJob('oneshot', ...)` wrap (llama-cpp can't share VRAM with a
// resident ACE-Step/ComfyUI process any better than TTS/Whisper do).

import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { defineRoute } from '../../lib/defineRoute.js';
import { ValidationError, InternalError } from '../../lib/errors.js';
import { run } from '../../lib/exec.js';
import { paths } from '../../config/paths.js';
import {
  LyricsModelsListResponseSchema,
  LyricsGenerateBodySchema,
  LyricsGenerateResponseSchema,
} from '../../contracts/ace/lyrics.contract.js';

interface LyricsModelCatalogEntry {
  id: string;
  name: string;
  description: string;
  size: string;
  repo: string;
  filename: string;
}

// Small, curated catalog — mirrors ace-step-ui's LYRICS_MODEL_CATALOG.
// Downloading these (HF hub pull) is not wired up yet; see the TODO below.
const LYRICS_MODEL_CATALOG: LyricsModelCatalogEntry[] = [
  {
    id: 'llama-song-stream-3b-q4',
    name: 'Song Stream 3B (Q4)',
    description: 'Fast, good quality lyrics generation',
    size: '2.0 GB',
    repo: 'prithivMLmods/Llama-Song-Stream-3B-Instruct-GGUF',
    filename: 'Llama-Song-Stream-3B-Instruct.Q4_K_M.gguf',
  },
  {
    id: 'llama-song-stream-3b-q8',
    name: 'Song Stream 3B (Q8)',
    description: 'Higher quality, uses more RAM',
    size: '3.5 GB',
    repo: 'prithivMLmods/Llama-Song-Stream-3B-Instruct-GGUF',
    filename: 'Llama-Song-Stream-3B-Instruct.Q8_0.gguf',
  },
];

function getModelPath(modelId: string): string | null {
  const entry = LYRICS_MODEL_CATALOG.find((m) => m.id === modelId);
  if (!entry) return null;
  return path.join(paths.aceLyricsModelsDir, entry.filename);
}

function isModelDownloaded(modelId: string): boolean {
  const modelPath = getModelPath(modelId);
  return !!modelPath && fs.existsSync(modelPath);
}

function getFirstDownloadedModel(): string | null {
  for (const m of LYRICS_MODEL_CATALOG) {
    if (isModelDownloaded(m.id)) return m.id;
  }
  return null;
}

interface LyricsScriptArgs {
  action: 'generate';
  model_path: string;
  genre?: string;
  language?: string;
  topic?: string;
  mood?: string;
  structure?: string;
}

/**
 * Run `lyrics_generate.py` argv-only (the whole args object is JSON-encoded
 * into a single argv element — never shell-interpolated). Returns the parsed
 * `{ lyrics }` payload, or null if no model is downloaded / the script fails.
 * Exported so `routes/ace/generate.routes.ts`'s Simple-mode orchestration can
 * reuse this instead of re-implementing the spawn.
 */
export async function generateLyrics(args: {
  genre?: string;
  language?: string;
  topic?: string;
  mood?: string;
  structure?: string;
  modelId?: string;
}): Promise<string | null> {
  const resolvedModelId = args.modelId || getFirstDownloadedModel();
  if (!resolvedModelId) return null;
  const modelPath = getModelPath(resolvedModelId);
  if (!modelPath || !fs.existsSync(modelPath)) return null;

  const scriptArgs: LyricsScriptArgs = {
    action: 'generate',
    model_path: modelPath,
    genre: args.genre || '',
    language: args.language || 'english',
    topic: args.topic || '',
    mood: args.mood || '',
    structure: args.structure || '',
  };

  const result = await run('python3', [paths.aceLyricsScript, JSON.stringify(scriptArgs)], {
    timeoutMs: 120_000,
  });
  if (result.timedOut || result.code !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout.trim()) as { lyrics?: string };
    return parsed.lyrics ?? null;
  } catch {
    return null;
  }
}

const modelsRoute = defineRoute({
  method: 'GET',
  path: '/ace/lyrics/models',
  response: LyricsModelsListResponseSchema,
  auth: { required: true, scopes: ['system:read'] },
  tags: ['ace'],
  summary: 'List the lyrics-LLM catalog and on-disk download status',
}, ({ ok }) => {
  const models = LYRICS_MODEL_CATALOG.map((m) => ({
    id: m.id,
    name: m.name,
    description: m.description,
    size: m.size,
    downloaded: isModelDownloaded(m.id),
  }));
  return ok({ models });
});

const generateRoute = defineRoute({
  method: 'POST',
  path: '/ace/lyrics/generate',
  body: LyricsGenerateBodySchema,
  response: LyricsGenerateResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
  tags: ['ace'],
  summary: 'Generate song lyrics from genre/topic/mood via the local GGUF lyrics model',
}, async ({ body, ok }) => {
  const resolvedModelId = body.modelId || getFirstDownloadedModel();
  if (!resolvedModelId) {
    throw new ValidationError('No lyrics model downloaded yet.');
  }
  const modelPath = getModelPath(resolvedModelId);
  if (!modelPath || !fs.existsSync(modelPath)) {
    throw new ValidationError(`Model ${resolvedModelId} is not downloaded.`);
  }

  const lyrics = await generateLyrics({ ...body, modelId: resolvedModelId });
  if (lyrics === null) {
    throw new InternalError('Lyrics generation failed');
  }
  return ok({ lyrics });
});

const router = Router();
[modelsRoute, generateRoute].forEach((r) => r.register(router));

export default router;

// TODO(later agent / follow-up): model download is not wired up yet — the
// catalog above lists `repo`/`filename` (HF hub coordinates) but there's no
// route to trigger `hf_hub_download` into `paths.aceLyricsModelsDir` the way
// ace-step-ui's `POST /lyrics/models/download` did. Until that lands, a
// lyrics model has to be placed on disk manually.
