// Import-from-ComfyUI service.
//
// Fetches the ComfyUI template catalog index, downloads each workflow JSON,
// writes it to user-workflows/ atomically, and upserts the DB row.
// Streams progress to the caller via SSE-style callback.
//
// Security:
//   - Template names are validated against /^[a-z0-9_-]{1,100}$/i before use.
//   - Each resolved path is verified to be under paths.userTemplatesDir.
//   - Atomic writes (tmp + rename) prevent partial files.
//   - Soft-deleted rows are skipped — user's hide decision is respected.
//   - No secrets are logged.

import fs from 'fs';
import path from 'path';
import { atomicWrite, safeResolve } from '../../lib/fs.js';
import { paths } from '../../config/paths.js';
import { logger } from '../../lib/logger.js';
import * as templateRepo from '../../lib/db/templates.repo.js';
import { generateFormInputs } from './templates.formInputs.js';
import { deriveStudioCategory } from './categoryMap.js';
import type { TemplateData, RawCategory } from './types.js';

export interface ImportProgress {
  type: 'progress';
  current: number;
  total: number;
  name: string;
}

export interface ImportSkip {
  type: 'skip';
  name: string;
  reason: 'soft-deleted' | 'unsafe-name' | 'fetch-failed' | 'parse-error';
}

export interface ImportDone {
  type: 'done';
  added: number;
  updated: number;
  skipped: number;
  errors: number;
}

export interface ImportError {
  type: 'error';
  message: string;
}

export type ImportEvent = ImportProgress | ImportSkip | ImportDone | ImportError;

export interface ComfyEntry {
  name: string;
  category: string;
  slim: RawCategory['templates'][number];
}

const NAME_RE = /^[a-z0-9_-]{1,100}$/i;
const CONCURRENCY = 6;

function sanitizeName(raw: string): string | null {
  const clean = raw.replace(/[^a-z0-9_-]/gi, '');
  if (!NAME_RE.test(clean)) return null;
  return clean;
}

function ensureDir(): void {
  try { fs.mkdirSync(paths.userTemplatesDir, { recursive: true, mode: 0o700 }); } catch { /* ok */ }
}

function filePath(name: string): string {
  return safeResolve(paths.userTemplatesDir, `${name}.json`);
}

/**
 * Fetch the ComfyUI template catalog index and flatten it to a list of entries.
 * Returns null when unreachable.
 */
async function fetchIndex(comfyUrl: string): Promise<ComfyEntry[] | null> {
  try {
    const res = await fetch(`${comfyUrl}/templates/index.json`);
    if (!res.ok) return null;
    const categories = await res.json() as RawCategory[];
    const entries: ComfyEntry[] = [];
    for (const cat of categories) {
      if (!cat.templates) continue;
      for (const t of cat.templates) {
        entries.push({ name: t.name, category: cat.title, slim: t });
      }
    }
    return entries;
  } catch {
    return null;
  }
}

async function fetchWorkflowJson(comfyUrl: string, name: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${comfyUrl}/templates/${encodeURIComponent(name)}.json`);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || typeof data !== 'object') return null;
    return data as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Run the import-from-ComfyUI pipeline, calling `emit` for each event.
 * Returns when the pipeline is complete (all workers finished).
 */
export async function runImportFromComfy(
  comfyUrl: string,
  emit: (event: ImportEvent) => void,
): Promise<void> {
  ensureDir();

  const entriesOrNull = await fetchIndex(comfyUrl);
  if (!entriesOrNull) {
    emit({ type: 'error', message: `ComfyUI unreachable at ${comfyUrl}` });
    return;
  }
  const entries: ComfyEntry[] = entriesOrNull;

  const total = entries.length;
  let current = 0;
  let added = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;
  let idx = 0;

  async function worker(): Promise<void> {
    while (idx < entries.length) {
      const myIdx = idx++;
      const entry = entries[myIdx];
      current++;
      emit({ type: 'progress', current, total, name: entry.name });

      // 1. Sanitize name — path traversal guard.
      const safeName = sanitizeName(entry.name);
      if (!safeName) {
        emit({ type: 'skip', name: entry.name, reason: 'unsafe-name' });
        skipped++;
        continue;
      }

      // Verify the resolved path stays inside user-workflows/.
      let absPath: string;
      try {
        absPath = filePath(safeName);
      } catch {
        emit({ type: 'skip', name: entry.name, reason: 'unsafe-name' });
        skipped++;
        continue;
      }

      // 2. Skip soft-deleted rows.
      if (templateRepo.isSoftDeleted(safeName)) {
        emit({ type: 'skip', name: safeName, reason: 'soft-deleted' });
        skipped++;
        continue;
      }

      // 3. Fetch workflow JSON from ComfyUI.
      const workflow = await fetchWorkflowJson(comfyUrl, entry.name);
      if (!workflow) {
        emit({ type: 'skip', name: safeName, reason: 'fetch-failed' });
        errors++;
        continue;
      }

      // 4. Build TemplateData from slim metadata + workflow.
      const studioCategory = deriveStudioCategory(entry.slim.mediaType, entry.category);
      const raw = entry.slim;
      const templateData: TemplateData = {
        name: safeName,
        title: raw.title || safeName,
        description: raw.description || '',
        mediaType: raw.mediaType || 'image',
        mediaSubtype: raw.mediaSubtype,
        tags: raw.tags || [],
        models: raw.models || [],
        category: entry.category,
        studioCategory,
        io: { inputs: raw.io?.inputs || [], outputs: raw.io?.outputs || [] },
        formInputs: generateFormInputs(raw),
        thumbnail: raw.thumbnail || [],
        thumbnailVariant: raw.thumbnailVariant,
        size: raw.size || 0,
        vram: raw.vram || 0,
        usage: raw.usage || 0,
        openSource: raw.openSource,
        username: raw.username,
        date: raw.date,
        logos: raw.logos,
        searchRank: raw.searchRank,
        workflow,
      };

      // 5. Write to disk atomically.
      try {
        atomicWrite(absPath, JSON.stringify(templateData, null, 2), { mode: 0o644, dirMode: 0o700 });
      } catch (err) {
        logger.error('importFromComfy: write failed', { name: safeName, error: String(err) });
        errors++;
        continue;
      }

      // 6. Upsert DB row with source_type=1 (comfy-catalog). Preserve
      //    existing favorite and soft_deleted by NOT overwriting them in
      //    writeRow's ON CONFLICT clause (those columns are intentionally omitted).
      const prior = templateRepo.getTemplate(safeName);
      const isNew = !prior;
      templateRepo.upsertTemplate(
        {
          name: safeName,
          displayName: templateData.title || safeName,
          category: templateData.category ?? null,
          description: templateData.description ?? null,
          tags_json: JSON.stringify(templateData.tags ?? []),
          installed: prior?.installed ?? false,
          source_type: templateRepo.SOURCE_COMFY_CATALOG,
          thumbnail_json: Array.isArray(templateData.thumbnail) && templateData.thumbnail.length > 0
            ? JSON.stringify(templateData.thumbnail) : null,
          media_type: templateData.mediaType ?? null,
          open_source: templateData.openSource === false ? 0 : 1,
          search_rank: typeof templateData.searchRank === 'number' ? templateData.searchRank : 0,
          username: templateData.username ?? null,
        },
        { models: templateData.models ?? [], plugins: [] },
      );

      if (isNew) {
        added++;
      } else {
        updated++;
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, Math.max(1, entries.length)) }, worker);
  await Promise.all(workers);

  emit({ type: 'done', added, updated, skipped, errors });
}
