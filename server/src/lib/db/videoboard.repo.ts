// Videoboard repository — projects, shots, analyses, and jobs.
// Characters live in characters.repo.ts.
//
// All JSON columns (character_ids, settings, lyrics, sections) are stored as
// JSON strings and deserialized on read. SQLite foreign keys are enabled in
// connection.ts (PRAGMA foreign_keys = ON).

import type Database from 'better-sqlite3';
import { getDb } from './connection.js';
import type { Project, Shot, Analysis, JobRecord, ProjectSettings } from '../../contracts/videoboard.js';

// ---- Defaults ----------------------------------------------------------------

const DEFAULT_SETTINGS: ProjectSettings = {
  fixedShotSeconds: 10,                             // matches OMNI_AUDIO_VideoScenes widget default
  styleHint: '',
  imageTemplateName: 'image_flux2_text_to_image_9b', // FLUX.2 Klein 9B — Apache 2.0, fits in 24 GB
};

// ---- Row hydrators -----------------------------------------------------------

function rowToProject(
  row: Record<string, unknown>,
  shots: Shot[],
): Project {
  // Merge stored settings on top of defaults so pre-existing projects that
  // were written under the old (richer) ProjectSettings schema still hydrate:
  // any keys we no longer recognize are passed through (harmless extras);
  // any keys we added since then (e.g. styleHint) fall back to the default.
  const storedSettings = parseJson<Partial<ProjectSettings>>(row.settings) ?? {};
  const settings: ProjectSettings = { ...DEFAULT_SETTINGS, ...storedSettings };
  return {
    id: String(row.id),
    name: String(row.name),
    audioPath: row.audio_path != null ? String(row.audio_path) : undefined,
    audioDurationMs: row.audio_duration_ms != null ? Number(row.audio_duration_ms) : undefined,
    analysisStatus: (row.analysis_status as Project['analysisStatus']) ?? 'none',
    characterIds: parseJson<string[]>(row.character_ids) ?? [],
    shots,
    settings,
    status: (row.status as Project['status']) ?? 'draft',
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

// Director-emitted fields ride inside the `scene_json` TEXT column (v28).
// Stored as one JSON blob so adding more fields later is column-free.
interface SceneBlob {
  imagePrompt?: string;
  videoPrompt?: string;
  keyVisual?: string;
  treatmentSnapshot?: string;
  chunkIdx?: number;
  imageTemplateName?: string;   // per-shot override
  imagePromptId?: string;       // last ComfyUI prompt_id for this shot's image
  savedLatentFilename?: string; // LTX chain-mode SaveLatent output for this shot
}

function rowToShot(row: Record<string, unknown>): Shot {
  const scene = parseJson<SceneBlob>(row.scene_json) ?? {};
  return {
    idx: Number(row.idx),
    startMs: Number(row.start_ms ?? 0),
    endMs: Number(row.end_ms ?? 0),
    lyrics: String(row.lyrics ?? ''),
    prompt: String(row.prompt ?? ''),
    seed: Number(row.seed ?? 0),
    imageUrl: row.image_url != null ? String(row.image_url) : undefined,
    videoUrl: row.video_url != null ? String(row.video_url) : undefined,
    status: (row.status as Shot['status']) ?? 'pending',
    ...(scene.imagePrompt !== undefined && { imagePrompt: scene.imagePrompt }),
    ...(scene.videoPrompt !== undefined && { videoPrompt: scene.videoPrompt }),
    ...(scene.keyVisual !== undefined && { keyVisual: scene.keyVisual }),
    ...(scene.treatmentSnapshot !== undefined && { treatmentSnapshot: scene.treatmentSnapshot }),
    ...(scene.chunkIdx !== undefined && { chunkIdx: scene.chunkIdx }),
    ...(scene.imageTemplateName !== undefined && { imageTemplateName: scene.imageTemplateName }),
    ...(scene.imagePromptId !== undefined && { imagePromptId: scene.imagePromptId }),
    ...(scene.savedLatentFilename !== undefined && { savedLatentFilename: scene.savedLatentFilename }),
  };
}

function rowToJob(row: Record<string, unknown>): JobRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    shotIdx: row.shot_idx != null ? Number(row.shot_idx) : undefined,
    kind: row.kind as JobRecord['kind'],
    status: row.status as JobRecord['status'],
    progress: Number(row.progress ?? 0),
    message: row.message != null ? String(row.message) : undefined,
    outputUrl: row.output_url != null ? String(row.output_url) : undefined,
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

function parseJson<T>(raw: unknown): T | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

// ---- Shots -------------------------------------------------------------------

function listShotsForProject(
  projectId: string,
  db: Database.Database,
): Shot[] {
  const rows = db.prepare(
    'SELECT * FROM videoboard_shots WHERE project_id = ? ORDER BY idx ASC',
  ).all(projectId) as Record<string, unknown>[];
  return rows.map(rowToShot);
}

// ---- Projects ----------------------------------------------------------------

export function listProjects(db: Database.Database = getDb()): Project[] {
  const rows = db.prepare(
    'SELECT * FROM videoboard_projects ORDER BY created_at DESC',
  ).all() as Record<string, unknown>[];
  return rows.map((r) => rowToProject(r, listShotsForProject(String(r.id), db)));
}

export function getProject(
  id: string,
  db: Database.Database = getDb(),
): Project | null {
  const row = db.prepare('SELECT * FROM videoboard_projects WHERE id = ?').get(id) as
    Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToProject(row, listShotsForProject(id, db));
}

export function createProject(
  id: string,
  name: string,
  db: Database.Database = getDb(),
): Project {
  const now = Date.now();
  db.prepare(`
    INSERT INTO videoboard_projects
      (id, name, analysis_status, character_ids, settings, status, created_at, updated_at)
    VALUES (?, ?, 'none', '[]', ?, 'draft', ?, ?)
  `).run(id, name, JSON.stringify(DEFAULT_SETTINGS), now, now);
  return getProject(id, db)!;
}

export function updateProject(
  id: string,
  patch: Partial<Omit<Project, 'id' | 'shots' | 'createdAt'>>,
  db: Database.Database = getDb(),
): Project | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  // Use `key in patch` (not `patch[k] !== undefined`) so that callers can
  // EXPLICITLY clear a column by passing `{ audioPath: undefined }`. With the
  // `!== undefined` form, undefined values were silently dropped — that was
  // why "remove audio" looked broken (the row's audio_path was never NULLed).
  if (patch.name !== undefined) { sets.push('name = ?'); params.push(patch.name); }
  if ('audioPath' in patch) { sets.push('audio_path = ?'); params.push(patch.audioPath ?? null); }
  if ('audioDurationMs' in patch) { sets.push('audio_duration_ms = ?'); params.push(patch.audioDurationMs ?? null); }
  if (patch.analysisStatus !== undefined) { sets.push('analysis_status = ?'); params.push(patch.analysisStatus); }
  if (patch.characterIds !== undefined) { sets.push('character_ids = ?'); params.push(JSON.stringify(patch.characterIds)); }
  if (patch.settings !== undefined) { sets.push('settings = ?'); params.push(JSON.stringify(patch.settings)); }
  if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status); }
  if (sets.length === 0) return getProject(id, db);
  const now = Date.now();
  sets.push('updated_at = ?'); params.push(now);
  params.push(id);
  db.prepare(`UPDATE videoboard_projects SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getProject(id, db);
}

export function deleteProject(
  id: string,
  db: Database.Database = getDb(),
): boolean {
  const r = db.prepare('DELETE FROM videoboard_projects WHERE id = ?').run(id);
  return r.changes > 0;
}

// ---- Shots -------------------------------------------------------------------

export function upsertShot(
  projectId: string,
  shot: Shot,
  db: Database.Database = getDb(),
): Shot {
  // Serialize the Director-emitted fields into the scene_json TEXT column.
  // Writing null (not '{}') when nothing is set keeps row size sane for the
  // common mock/legacy case.
  const sceneBlob: SceneBlob = {};
  if (shot.imagePrompt !== undefined) sceneBlob.imagePrompt = shot.imagePrompt;
  if (shot.videoPrompt !== undefined) sceneBlob.videoPrompt = shot.videoPrompt;
  if (shot.keyVisual !== undefined) sceneBlob.keyVisual = shot.keyVisual;
  if (shot.treatmentSnapshot !== undefined) sceneBlob.treatmentSnapshot = shot.treatmentSnapshot;
  if (shot.chunkIdx !== undefined) sceneBlob.chunkIdx = shot.chunkIdx;
  if (shot.imageTemplateName !== undefined) sceneBlob.imageTemplateName = shot.imageTemplateName;
  if (shot.imagePromptId !== undefined) sceneBlob.imagePromptId = shot.imagePromptId;
  if (shot.savedLatentFilename !== undefined) sceneBlob.savedLatentFilename = shot.savedLatentFilename;
  const sceneJson = Object.keys(sceneBlob).length > 0 ? JSON.stringify(sceneBlob) : null;

  db.prepare(`
    INSERT INTO videoboard_shots
      (project_id, idx, start_ms, end_ms, lyrics, prompt, seed, image_url, video_url, status, scene_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, idx) DO UPDATE SET
      start_ms   = excluded.start_ms,
      end_ms     = excluded.end_ms,
      lyrics     = excluded.lyrics,
      prompt     = excluded.prompt,
      seed       = excluded.seed,
      image_url  = excluded.image_url,
      video_url  = excluded.video_url,
      status     = excluded.status,
      scene_json = excluded.scene_json
  `).run(
    projectId,
    shot.idx,
    shot.startMs,
    shot.endMs,
    shot.lyrics,
    shot.prompt,
    shot.seed,
    shot.imageUrl ?? null,
    shot.videoUrl ?? null,
    shot.status,
    sceneJson,
  );
  const row = db.prepare(
    'SELECT * FROM videoboard_shots WHERE project_id = ? AND idx = ?',
  ).get(projectId, shot.idx) as Record<string, unknown>;
  return rowToShot(row);
}

export function getShot(
  projectId: string,
  idx: number,
  db: Database.Database = getDb(),
): Shot | null {
  const row = db.prepare(
    'SELECT * FROM videoboard_shots WHERE project_id = ? AND idx = ?',
  ).get(projectId, idx) as Record<string, unknown> | undefined;
  return row ? rowToShot(row) : null;
}

export function updateShot(
  projectId: string,
  idx: number,
  patch: Partial<Shot>,
  db: Database.Database = getDb(),
): Shot | null {
  const existing = getShot(projectId, idx, db);
  if (!existing) return null;
  const merged: Shot = { ...existing, ...patch, idx };
  return upsertShot(projectId, merged, db);
}

/** Delete every shot for a project. Used when audio (and therefore the
 *  storyboard built from it) is removed or replaced. */
export function deleteShots(
  projectId: string,
  db: Database.Database = getDb(),
): number {
  return db
    .prepare('DELETE FROM videoboard_shots WHERE project_id = ?')
    .run(projectId).changes;
}

export function replaceShots(
  projectId: string,
  shots: Shot[],
  db: Database.Database = getDb(),
): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM videoboard_shots WHERE project_id = ?').run(projectId);
    for (const s of shots) upsertShot(projectId, s, db);
  });
  tx();
}

// ---- Analyses ----------------------------------------------------------------
//
// The whole Analysis lives in a single TEXT column `analysis_json` as the
// JSON blob the OMNI_AUDIO_Analyze node emits. No mapping layer — the DB
// shape and the analyzer output are byte-identical. Legacy columns from
// pre-v27 schemas (bpm/energy/lyrics_json/sections_json/metadata_json) are
// not read or written; old rows are effectively orphaned and getAnalysis
// returns null for them, which the route treats as "no analysis yet".

type AnalysisType = import('../../contracts/videoboard.js').Analysis;

export function upsertAnalysis(
  projectId: string,
  analysis: AnalysisType,
  db: Database.Database = getDb(),
): void {
  db.prepare(`
    INSERT INTO videoboard_analyses (project_id, analysis_json)
    VALUES (?, ?)
    ON CONFLICT(project_id) DO UPDATE SET
      analysis_json = excluded.analysis_json
  `).run(projectId, JSON.stringify(analysis));
}

export function getAnalysis(
  projectId: string,
  db: Database.Database = getDb(),
): AnalysisType | null {
  const row = db.prepare(
    'SELECT analysis_json FROM videoboard_analyses WHERE project_id = ?',
  ).get(projectId) as { analysis_json?: unknown } | undefined;
  if (!row) return null;
  return parseJson<AnalysisType>(row.analysis_json);
}

export function deleteAnalysis(
  projectId: string,
  db: Database.Database = getDb(),
): boolean {
  const r = db.prepare('DELETE FROM videoboard_analyses WHERE project_id = ?').run(projectId);
  return r.changes > 0;
}

// ---- Jobs --------------------------------------------------------------------

export function upsertJob(
  job: JobRecord,
  db: Database.Database = getDb(),
): void {
  db.prepare(`
    INSERT INTO videoboard_jobs
      (id, project_id, shot_idx, kind, status, progress, message, output_url, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status     = excluded.status,
      progress   = excluded.progress,
      message    = excluded.message,
      output_url = excluded.output_url,
      updated_at = excluded.updated_at
  `).run(
    job.id,
    job.projectId,
    job.shotIdx ?? null,
    job.kind,
    job.status,
    job.progress,
    job.message ?? null,
    job.outputUrl ?? null,
    job.createdAt,
    job.updatedAt,
  );
}

export function getJob(
  id: string,
  db: Database.Database = getDb(),
): JobRecord | null {
  const row = db.prepare('SELECT * FROM videoboard_jobs WHERE id = ?').get(id) as
    Record<string, unknown> | undefined;
  return row ? rowToJob(row) : null;
}

export function listJobsForProject(
  projectId: string,
  db: Database.Database = getDb(),
): JobRecord[] {
  const rows = db.prepare(
    'SELECT * FROM videoboard_jobs WHERE project_id = ? ORDER BY created_at DESC',
  ).all(projectId) as Record<string, unknown>[];
  return rows.map(rowToJob);
}
