// Pending soul edit proposals. The model calls studio_propose_soul_edit which
// writes a JSON file here; the user reviews and accepts/rejects via the API.
// Nothing is applied to a soul file without an explicit accept.

import fs from 'fs';
import path from 'path';
import { currentConfigRootOverride } from '../../../config/env.js';
import { safeResolve } from '../../../lib/fs.js';
import { loadSoul, isValidSoulName, writeSoul, loadSoulBody } from './loader.js';
import os from 'os';

export interface PendingEdit {
  id: string;
  soulName: string;
  reason: string;
  currentSection: string | null;
  proposedReplacement: string;
  createdAt: number;
}

// --- path helpers ---

function getPendingSoulEditsDir(): string {
  const configRoot = currentConfigRootOverride()
    ?? path.join(os.homedir(), '.config', 'comfyui-studio');
  return path.join(configRoot, 'personalities', 'pending-soul-edits');
}

function getSoulBackupsDir(): string {
  const configRoot = currentConfigRootOverride()
    ?? path.join(os.homedir(), '.config', 'comfyui-studio');
  return path.join(configRoot, 'personalities', 'soul-backups');
}

function editFilePath(id: string): string {
  const dir = getPendingSoulEditsDir();
  return safeResolve(dir, `${id}.json`);
}

// --- ID generation matching the pattern used in chat.routes.ts ---

function makeId(): string {
  return Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
}

// --- public API ---

export function listPendingEdits(): PendingEdit[] {
  const dir = getPendingSoulEditsDir();
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return []; }

  const results: PendingEdit[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const p = safeResolve(dir, entry);
      const raw = fs.readFileSync(p, 'utf8');
      const parsed = JSON.parse(raw) as PendingEdit;
      results.push(parsed);
    } catch { /* skip corrupt files */ }
  }
  return results.sort((a, b) => a.createdAt - b.createdAt);
}

export function getPendingEdit(id: string): PendingEdit | null {
  try {
    const p = editFilePath(id);
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw) as PendingEdit;
  } catch {
    return null;
  }
}

export function createPendingEdit(
  input: Omit<PendingEdit, 'id' | 'createdAt'>,
): PendingEdit {
  const edit: PendingEdit = {
    ...input,
    id: makeId(),
    createdAt: Date.now(),
  };
  const dir = getPendingSoulEditsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = safeResolve(dir, `${edit.id}.json`);
  fs.writeFileSync(p, JSON.stringify(edit, null, 2), { encoding: 'utf8', mode: 0o600 });
  return edit;
}

export function deletePendingEdit(id: string): boolean {
  try {
    const p = editFilePath(id);
    fs.unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

export function applyPendingEdit(id: string): { ok: boolean; soulName: string } {
  const edit = getPendingEdit(id);
  if (!edit) return { ok: false, soulName: '' };

  const body = loadSoulBody(edit.soulName);

  // If the section to replace is given but not found in the body, refuse to
  // apply. Ambiguous replacement could corrupt the soul silently.
  if (edit.currentSection !== null && !body.includes(edit.currentSection)) {
    return { ok: false, soulName: edit.soulName };
  }

  // Back up the soul file before mutating it.
  backupSoul(edit.soulName, body);

  const newBody = edit.currentSection === null
    // Append mode: add the proposed text after a blank line separator.
    ? (body.trimEnd() + '\n\n' + edit.proposedReplacement)
    // Replace mode: swap the first occurrence of the matched section.
    : body.replace(edit.currentSection, edit.proposedReplacement);

  writeSoul(edit.soulName, newBody);
  deletePendingEdit(id);
  return { ok: true, soulName: edit.soulName };
}

// --- internal ---

function backupSoul(soulName: string, body: string): void {
  const backupsDir = getSoulBackupsDir();
  fs.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
  const timestamp = Date.now();
  const filename = `${timestamp}-${soulName}.md`;
  const p = safeResolve(backupsDir, filename);
  fs.writeFileSync(p, body, { encoding: 'utf8', mode: 0o600 });
}

