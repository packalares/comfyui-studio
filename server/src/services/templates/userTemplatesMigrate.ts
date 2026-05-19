// Boot-time migration for user-workflow plugin arrays.
//
// Extracted from userTemplates.ts to keep that file under the 250-line cap.
// The migration canonicalises + deduplicates the `plugins[]` array in every
// user-workflow JSON on first call per process. Idempotent — a second run is
// a no-op because the data is already canonical.

import fs from 'fs';
import { atomicWrite, safeResolve } from '../../lib/fs.js';
import { paths } from '../../config/paths.js';
import { logger } from '../../lib/logger.js';
import { dedupKey } from '../plugins/nodes.js';
import type { TemplateData, TemplatePluginEntry } from './types.js';

const DIR = (): string => paths.userTemplatesDir;

let pluginsMigrationRan = false;

export function migrateUserWorkflowPluginsOnce(): void {
  if (pluginsMigrationRan) return;
  pluginsMigrationRan = true;
  try {
    if (!fs.existsSync(DIR())) return;
    const files = fs.readdirSync(DIR()).filter(
      (f) => f.endsWith('.json') && !f.endsWith('.meta.json'),
    );
    let touched = 0;
    for (const f of files) {
      try {
        const abs = safeResolve(DIR(), f);
        const raw = fs.readFileSync(abs, 'utf8');
        const parsed = JSON.parse(raw) as TemplateData;
        const before = parsed.plugins ?? [];
        if (before.length === 0) continue;
        const byCanonical = new Map<string, TemplatePluginEntry>();
        for (const p of before) {
          const key = (p.repo || '').trim();
          if (!key) continue;
          const dk = dedupKey(key);
          const existing = byCanonical.get(dk);
          if (!existing) {
            byCanonical.set(dk, p);
          } else if (p.repo.includes('/') && !existing.repo.includes('/')) {
            byCanonical.set(dk, { ...p, cnr_id: p.cnr_id ?? existing.cnr_id });
          } else if (!existing.cnr_id && p.cnr_id) {
            byCanonical.set(dk, { ...existing, cnr_id: p.cnr_id });
          }
        }
        const after = Array.from(byCanonical.values());
        if (after.length === before.length) continue;
        parsed.plugins = after;
        atomicWrite(abs, JSON.stringify(parsed, null, 2));
        touched++;
        logger.info('user workflow plugins migrated', {
          name: parsed.name, before: before.length, after: after.length,
        });
      } catch (err) {
        logger.warn('user workflow plugins migration failed', {
          file: f, error: String(err),
        });
      }
    }
    if (touched > 0) {
      logger.info('user workflow plugins migration complete', { rewritten: touched });
    }
  } catch (err) {
    logger.error('user workflow plugins migration scan failed', { error: String(err) });
  }
}
