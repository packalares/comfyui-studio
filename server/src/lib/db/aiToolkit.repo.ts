// Repository for `ai_toolkit_jobs` (migration 0007) — image-LoRA training
// job status/progress/config, the source of truth for the Train LoRA page
// (see `services/aiToolkit/train.ts`'s header comment for why this table,
// unlike the ACE-Step training tables, IS the source of truth rather than a
// cache over some other long-running process's state).
//
// Single-user: no `user_id` column, no ownership checks — matches every
// other repo in this schema.

import type Database from 'better-sqlite3';
import { getDb } from './connection.js';

export type AiToolkitJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface AiToolkitJobRow {
  id: string;
  name: string;
  baseModel: string;
  datasetPath: string;
  config: Record<string, unknown>;
  status: AiToolkitJobStatus;
  progress: number;
  step: number;
  totalSteps: number;
  outputPath: string | null;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface AiToolkitJobDbRow {
  id: string;
  name: string;
  base_model: string;
  dataset_path: string;
  config_json: string;
  status: AiToolkitJobStatus;
  progress: number;
  step: number;
  total_steps: number;
  output_path: string | null;
  error: string | null;
  started_at: number | null;
  finished_at: number | null;
  created_at: number;
  updated_at: number;
}

function parseConfig(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function rowToJob(r: AiToolkitJobDbRow): AiToolkitJobRow {
  return {
    id: r.id,
    name: r.name,
    baseModel: r.base_model,
    datasetPath: r.dataset_path,
    config: parseConfig(r.config_json),
    status: r.status,
    progress: r.progress,
    step: r.step,
    totalSteps: r.total_steps,
    outputPath: r.output_path,
    error: r.error,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface NewAiToolkitJobInput {
  id: string;
  name: string;
  baseModel: string;
  datasetPath: string;
  config: Record<string, unknown>;
}

export function insertAiToolkitJob(
  input: NewAiToolkitJobInput,
  db: Database.Database = getDb(),
): AiToolkitJobRow {
  const now = Date.now();
  db.prepare(`
    INSERT INTO ai_toolkit_jobs
      (id, name, base_model, dataset_path, config_json, status, created_at, updated_at)
    VALUES
      (@id, @name, @base_model, @dataset_path, @config_json, 'queued', @created_at, @updated_at)
  `).run({
    id: input.id,
    name: input.name,
    base_model: input.baseModel,
    dataset_path: input.datasetPath,
    config_json: JSON.stringify(input.config),
    created_at: now,
    updated_at: now,
  });
  return getAiToolkitJob(input.id, db)!;
}

export function getAiToolkitJob(id: string, db: Database.Database = getDb()): AiToolkitJobRow | null {
  const row = db.prepare('SELECT * FROM ai_toolkit_jobs WHERE id = ?').get(id) as
    AiToolkitJobDbRow | undefined;
  return row ? rowToJob(row) : null;
}

export function listAiToolkitJobs(limit = 50, db: Database.Database = getDb()): AiToolkitJobRow[] {
  const rows = db.prepare(
    'SELECT * FROM ai_toolkit_jobs ORDER BY created_at DESC LIMIT ?',
  ).all(Math.min(Math.max(limit, 1), 200)) as AiToolkitJobDbRow[];
  return rows.map(rowToJob);
}

export interface AiToolkitJobUpdateInput {
  status?: AiToolkitJobStatus;
  progress?: number;
  step?: number;
  totalSteps?: number;
  outputPath?: string | null;
  error?: string | null;
  startedAt?: number | null;
  finishedAt?: number | null;
}

export function updateAiToolkitJob(
  id: string,
  input: AiToolkitJobUpdateInput,
  db: Database.Database = getDb(),
): AiToolkitJobRow | null {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id, updated_at: Date.now() };
  if (input.status !== undefined) { sets.push('status = @status'); params.status = input.status; }
  if (input.progress !== undefined) { sets.push('progress = @progress'); params.progress = input.progress; }
  if (input.step !== undefined) { sets.push('step = @step'); params.step = input.step; }
  if (input.totalSteps !== undefined) { sets.push('total_steps = @total_steps'); params.total_steps = input.totalSteps; }
  if (input.outputPath !== undefined) { sets.push('output_path = @output_path'); params.output_path = input.outputPath; }
  if (input.error !== undefined) { sets.push('error = @error'); params.error = input.error; }
  if (input.startedAt !== undefined) { sets.push('started_at = @started_at'); params.started_at = input.startedAt; }
  if (input.finishedAt !== undefined) { sets.push('finished_at = @finished_at'); params.finished_at = input.finishedAt; }
  if (sets.length === 0) return getAiToolkitJob(id, db);
  sets.push('updated_at = @updated_at');
  db.prepare(`UPDATE ai_toolkit_jobs SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return getAiToolkitJob(id, db);
}
