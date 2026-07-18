// Repository for the ACE-Step training/LoRA/TTS/reference-track tables added
// in migration 0006 (`ace_training_datasets`, `ace_training_runs`,
// `ace_stem_jobs`, `ace_tts_jobs`, `ace_reference_tracks`).
//
// Single-user: no `user_id` column, no ownership checks — see the migration
// file's header comment for the full ace-step-ui -> comfy simplification
// rationale (also matches `aceMusic.repo.ts`'s pattern).

import type Database from 'better-sqlite3';
import { getDb } from './connection.js';

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function parseJsonObject<T extends Record<string, unknown>>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) ? parsed as T : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Training datasets
// ---------------------------------------------------------------------------

export interface TrainingDatasetRow {
  id: string;
  name: string;
  datasetPath: string;
  sampleCount: number;
  customTag: string | null;
  tagPosition: string | null;
  allInstrumental: boolean;
  genreRatio: number;
  createdAt: number;
  updatedAt: number;
}

interface TrainingDatasetDbRow {
  id: string;
  name: string;
  dataset_path: string;
  sample_count: number;
  custom_tag: string | null;
  tag_position: string | null;
  all_instrumental: number;
  genre_ratio: number;
  created_at: number;
  updated_at: number;
}

function rowToDataset(r: TrainingDatasetDbRow): TrainingDatasetRow {
  return {
    id: r.id,
    name: r.name,
    datasetPath: r.dataset_path,
    sampleCount: r.sample_count,
    customTag: r.custom_tag,
    tagPosition: r.tag_position,
    allInstrumental: r.all_instrumental === 1,
    genreRatio: r.genre_ratio,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface UpsertDatasetInput {
  id: string;
  name: string;
  datasetPath: string;
  sampleCount: number;
  customTag?: string | null;
  tagPosition?: string | null;
  allInstrumental?: boolean;
  genreRatio?: number;
}

/** Insert or update-by-name (dataset names are the natural key the training
 *  panel operates on — re-building/re-loading the same name refreshes it). */
export function upsertTrainingDataset(
  input: UpsertDatasetInput,
  db: Database.Database = getDb(),
): TrainingDatasetRow {
  const now = Date.now();
  db.prepare(`
    INSERT INTO ace_training_datasets
      (id, name, dataset_path, sample_count, custom_tag, tag_position,
       all_instrumental, genre_ratio, created_at, updated_at)
    VALUES
      (@id, @name, @dataset_path, @sample_count, @custom_tag, @tag_position,
       @all_instrumental, @genre_ratio, @created_at, @updated_at)
    ON CONFLICT(name) DO UPDATE SET
      dataset_path      = excluded.dataset_path,
      sample_count      = excluded.sample_count,
      custom_tag        = excluded.custom_tag,
      tag_position      = excluded.tag_position,
      all_instrumental  = excluded.all_instrumental,
      genre_ratio       = excluded.genre_ratio,
      updated_at        = excluded.updated_at
  `).run({
    id: input.id,
    name: input.name,
    dataset_path: input.datasetPath,
    sample_count: input.sampleCount,
    custom_tag: input.customTag ?? null,
    tag_position: input.tagPosition ?? null,
    all_instrumental: input.allInstrumental === false ? 0 : 1,
    genre_ratio: input.genreRatio ?? 0,
    created_at: now,
    updated_at: now,
  });
  return getTrainingDatasetByName(input.name, db)!;
}

export function getTrainingDatasetByName(
  name: string,
  db: Database.Database = getDb(),
): TrainingDatasetRow | null {
  const row = db.prepare('SELECT * FROM ace_training_datasets WHERE name = ?').get(name) as
    TrainingDatasetDbRow | undefined;
  return row ? rowToDataset(row) : null;
}

export function listTrainingDatasets(db: Database.Database = getDb()): TrainingDatasetRow[] {
  const rows = db.prepare('SELECT * FROM ace_training_datasets ORDER BY updated_at DESC').all() as
    TrainingDatasetDbRow[];
  return rows.map(rowToDataset);
}

// ---------------------------------------------------------------------------
// Training runs
// ---------------------------------------------------------------------------

export type TrainingRunStatus = 'running' | 'succeeded' | 'failed' | 'stopped';

export interface TrainingRunRow {
  id: string;
  datasetName: string | null;
  tensorDir: string | null;
  outputDir: string;
  hyperparams: Record<string, unknown>;
  status: TrainingRunStatus;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface TrainingRunDbRow {
  id: string;
  dataset_name: string | null;
  tensor_dir: string | null;
  output_dir: string;
  hyperparams_json: string;
  status: TrainingRunStatus;
  error: string | null;
  started_at: number;
  finished_at: number | null;
  created_at: number;
  updated_at: number;
}

function rowToRun(r: TrainingRunDbRow): TrainingRunRow {
  return {
    id: r.id,
    datasetName: r.dataset_name,
    tensorDir: r.tensor_dir,
    outputDir: r.output_dir,
    hyperparams: parseJsonObject(r.hyperparams_json) ?? {},
    status: r.status,
    error: r.error,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface NewTrainingRunInput {
  id: string;
  datasetName?: string | null;
  tensorDir?: string | null;
  outputDir: string;
  hyperparams: Record<string, unknown>;
}

export function insertTrainingRun(
  input: NewTrainingRunInput,
  db: Database.Database = getDb(),
): TrainingRunRow {
  const now = Date.now();
  db.prepare(`
    INSERT INTO ace_training_runs
      (id, dataset_name, tensor_dir, output_dir, hyperparams_json, status, started_at, created_at, updated_at)
    VALUES
      (@id, @dataset_name, @tensor_dir, @output_dir, @hyperparams_json, 'running', @started_at, @created_at, @updated_at)
  `).run({
    id: input.id,
    dataset_name: input.datasetName ?? null,
    tensor_dir: input.tensorDir ?? null,
    output_dir: input.outputDir,
    hyperparams_json: JSON.stringify(input.hyperparams),
    started_at: now,
    created_at: now,
    updated_at: now,
  });
  return getTrainingRun(input.id, db)!;
}

export function getTrainingRun(id: string, db: Database.Database = getDb()): TrainingRunRow | null {
  const row = db.prepare('SELECT * FROM ace_training_runs WHERE id = ?').get(id) as
    TrainingRunDbRow | undefined;
  return row ? rowToRun(row) : null;
}

/** Most recently started run, regardless of status — used to resolve "the
 *  active/last training run" without the client having to track an id. */
export function getLatestTrainingRun(db: Database.Database = getDb()): TrainingRunRow | null {
  const row = db.prepare('SELECT * FROM ace_training_runs ORDER BY started_at DESC LIMIT 1').get() as
    TrainingRunDbRow | undefined;
  return row ? rowToRun(row) : null;
}

export interface TrainingRunUpdateInput {
  status?: TrainingRunStatus;
  error?: string | null;
  finishedAt?: number | null;
}

export function updateTrainingRun(
  id: string,
  input: TrainingRunUpdateInput,
  db: Database.Database = getDb(),
): TrainingRunRow | null {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id, updated_at: Date.now() };
  if (input.status !== undefined) { sets.push('status = @status'); params.status = input.status; }
  if (input.error !== undefined) { sets.push('error = @error'); params.error = input.error; }
  if (input.finishedAt !== undefined) { sets.push('finished_at = @finished_at'); params.finished_at = input.finishedAt; }
  if (sets.length === 0) return getTrainingRun(id, db);
  sets.push('updated_at = @updated_at');
  db.prepare(`UPDATE ace_training_runs SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return getTrainingRun(id, db);
}

export function listTrainingRuns(limit = 50, db: Database.Database = getDb()): TrainingRunRow[] {
  const rows = db.prepare(
    'SELECT * FROM ace_training_runs ORDER BY created_at DESC LIMIT ?',
  ).all(Math.min(Math.max(limit, 1), 200)) as TrainingRunDbRow[];
  return rows.map(rowToRun);
}

// ---------------------------------------------------------------------------
// Stem-separation jobs
// ---------------------------------------------------------------------------

export type StemJobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface StemJobRow {
  id: string;
  status: StemJobStatus;
  progress: number;
  current: number;
  total: number;
  log: string[];
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

interface StemJobDbRow {
  id: string;
  status: StemJobStatus;
  progress: number;
  current_idx: number;
  total: number;
  log_json: string;
  result_json: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

const MAX_JOB_LOG_LINES = 200;

function rowToStemJob(r: StemJobDbRow): StemJobRow {
  return {
    id: r.id,
    status: r.status,
    progress: r.progress,
    current: r.current_idx,
    total: r.total,
    log: parseJsonArray(r.log_json),
    result: parseJsonObject(r.result_json),
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function createStemJob(id: string, total: number, db: Database.Database = getDb()): StemJobRow {
  const now = Date.now();
  db.prepare(`
    INSERT INTO ace_stem_jobs (id, status, progress, current_idx, total, log_json, created_at, updated_at)
    VALUES (?, 'queued', 0, 0, ?, '[]', ?, ?)
  `).run(id, total, now, now);
  return getStemJob(id, db)!;
}

export function getStemJob(id: string, db: Database.Database = getDb()): StemJobRow | null {
  const row = db.prepare('SELECT * FROM ace_stem_jobs WHERE id = ?').get(id) as StemJobDbRow | undefined;
  return row ? rowToStemJob(row) : null;
}

export interface StemJobUpdateInput {
  status?: StemJobStatus;
  progress?: number;
  current?: number;
  result?: Record<string, unknown> | null;
  error?: string | null;
  /** Appends one line to the job's log (trimmed to the last 200 lines). */
  appendLog?: string;
}

export function updateStemJob(
  id: string,
  input: StemJobUpdateInput,
  db: Database.Database = getDb(),
): StemJobRow | null {
  const existing = getStemJob(id, db);
  if (!existing) return null;
  const sets: string[] = [];
  const params: Record<string, unknown> = { id, updated_at: Date.now() };
  if (input.status !== undefined) { sets.push('status = @status'); params.status = input.status; }
  if (input.progress !== undefined) { sets.push('progress = @progress'); params.progress = input.progress; }
  if (input.current !== undefined) { sets.push('current_idx = @current_idx'); params.current_idx = input.current; }
  if (input.result !== undefined) {
    sets.push('result_json = @result_json');
    params.result_json = input.result === null ? null : JSON.stringify(input.result);
  }
  if (input.error !== undefined) { sets.push('error = @error'); params.error = input.error; }
  if (input.appendLog !== undefined) {
    const log = [...existing.log, input.appendLog];
    if (log.length > MAX_JOB_LOG_LINES) log.splice(0, log.length - MAX_JOB_LOG_LINES);
    sets.push('log_json = @log_json');
    params.log_json = JSON.stringify(log);
  }
  if (sets.length === 0) return existing;
  sets.push('updated_at = @updated_at');
  db.prepare(`UPDATE ace_stem_jobs SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return getStemJob(id, db);
}

// ---------------------------------------------------------------------------
// TTS (IndexTTS2) jobs
// ---------------------------------------------------------------------------

export type TtsJobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface TtsJobRow {
  id: string;
  status: TtsJobStatus;
  progress: number;
  log: string[];
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

interface TtsJobDbRow {
  id: string;
  status: TtsJobStatus;
  progress: number;
  log_json: string;
  result_json: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

function rowToTtsJob(r: TtsJobDbRow): TtsJobRow {
  return {
    id: r.id,
    status: r.status,
    progress: r.progress,
    log: parseJsonArray(r.log_json),
    result: parseJsonObject(r.result_json),
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function createTtsJob(id: string, db: Database.Database = getDb()): TtsJobRow {
  const now = Date.now();
  db.prepare(`
    INSERT INTO ace_tts_jobs (id, status, progress, log_json, created_at, updated_at)
    VALUES (?, 'queued', 0, '[]', ?, ?)
  `).run(id, now, now);
  return getTtsJob(id, db)!;
}

export function getTtsJob(id: string, db: Database.Database = getDb()): TtsJobRow | null {
  const row = db.prepare('SELECT * FROM ace_tts_jobs WHERE id = ?').get(id) as TtsJobDbRow | undefined;
  return row ? rowToTtsJob(row) : null;
}

export interface TtsJobUpdateInput {
  status?: TtsJobStatus;
  progress?: number;
  result?: Record<string, unknown> | null;
  error?: string | null;
  appendLog?: string;
}

export function updateTtsJob(
  id: string,
  input: TtsJobUpdateInput,
  db: Database.Database = getDb(),
): TtsJobRow | null {
  const existing = getTtsJob(id, db);
  if (!existing) return null;
  const sets: string[] = [];
  const params: Record<string, unknown> = { id, updated_at: Date.now() };
  if (input.status !== undefined) { sets.push('status = @status'); params.status = input.status; }
  if (input.progress !== undefined) { sets.push('progress = @progress'); params.progress = input.progress; }
  if (input.result !== undefined) {
    sets.push('result_json = @result_json');
    params.result_json = input.result === null ? null : JSON.stringify(input.result);
  }
  if (input.error !== undefined) { sets.push('error = @error'); params.error = input.error; }
  if (input.appendLog !== undefined) {
    const rawLine = input.appendLog;
    const line = rawLine.length > 1000 ? `${rawLine.slice(0, 1000)}…` : rawLine;
    const log = [...existing.log, line];
    if (log.length > MAX_JOB_LOG_LINES) log.splice(0, log.length - MAX_JOB_LOG_LINES);
    sets.push('log_json = @log_json');
    params.log_json = JSON.stringify(log);
  }
  if (sets.length === 0) return existing;
  sets.push('updated_at = @updated_at');
  db.prepare(`UPDATE ace_tts_jobs SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return getTtsJob(id, db);
}

// ---------------------------------------------------------------------------
// Reference tracks
// ---------------------------------------------------------------------------

export interface ReferenceTrackRow {
  id: string;
  filename: string;
  storageKey: string;
  duration: number | null;
  fileSizeBytes: number | null;
  lyrics: string | null;
  tags: string[];
  createdAt: number;
}

interface ReferenceTrackDbRow {
  id: string;
  filename: string;
  storage_key: string;
  duration: number | null;
  file_size_bytes: number | null;
  lyrics: string | null;
  tags_json: string;
  created_at: number;
}

function rowToReferenceTrack(r: ReferenceTrackDbRow): ReferenceTrackRow {
  return {
    id: r.id,
    filename: r.filename,
    storageKey: r.storage_key,
    duration: r.duration,
    fileSizeBytes: r.file_size_bytes,
    lyrics: r.lyrics,
    tags: parseJsonArray(r.tags_json),
    createdAt: r.created_at,
  };
}

export interface NewReferenceTrackInput {
  id: string;
  filename: string;
  storageKey: string;
  fileSizeBytes?: number | null;
  tags?: string[] | null;
}

export function insertReferenceTrack(
  input: NewReferenceTrackInput,
  db: Database.Database = getDb(),
): ReferenceTrackRow {
  db.prepare(`
    INSERT INTO ace_reference_tracks (id, filename, storage_key, file_size_bytes, tags_json, created_at)
    VALUES (@id, @filename, @storage_key, @file_size_bytes, @tags_json, @created_at)
  `).run({
    id: input.id,
    filename: input.filename,
    storage_key: input.storageKey,
    file_size_bytes: input.fileSizeBytes ?? null,
    tags_json: JSON.stringify(input.tags ?? []),
    created_at: Date.now(),
  });
  return getReferenceTrack(input.id, db)!;
}

export function getReferenceTrack(id: string, db: Database.Database = getDb()): ReferenceTrackRow | null {
  const row = db.prepare('SELECT * FROM ace_reference_tracks WHERE id = ?').get(id) as
    ReferenceTrackDbRow | undefined;
  return row ? rowToReferenceTrack(row) : null;
}

export function listReferenceTracks(db: Database.Database = getDb()): ReferenceTrackRow[] {
  const rows = db.prepare('SELECT * FROM ace_reference_tracks ORDER BY created_at DESC').all() as
    ReferenceTrackDbRow[];
  return rows.map(rowToReferenceTrack);
}

export interface ReferenceTrackUpdateInput {
  duration?: number | null;
  lyrics?: string | null;
  tags?: string[];
}

export function updateReferenceTrack(
  id: string,
  input: ReferenceTrackUpdateInput,
  db: Database.Database = getDb(),
): ReferenceTrackRow | null {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };
  if (input.duration !== undefined) { sets.push('duration = @duration'); params.duration = input.duration; }
  if (input.lyrics !== undefined) { sets.push('lyrics = @lyrics'); params.lyrics = input.lyrics; }
  if (input.tags !== undefined) { sets.push('tags_json = @tags_json'); params.tags_json = JSON.stringify(input.tags); }
  if (sets.length === 0) return getReferenceTrack(id, db);
  db.prepare(`UPDATE ace_reference_tracks SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return getReferenceTrack(id, db);
}

/** Returns the row's `storage_key` (pre-delete) so the caller can clean up
 *  the underlying file, then removes the row. Null if no such track. */
export function deleteReferenceTrack(
  id: string,
  db: Database.Database = getDb(),
): { storageKey: string } | null {
  const row = db.prepare('SELECT storage_key FROM ace_reference_tracks WHERE id = ?').get(id) as
    { storage_key: string } | undefined;
  if (!row) return null;
  db.prepare('DELETE FROM ace_reference_tracks WHERE id = ?').run(id);
  return { storageKey: row.storage_key };
}
