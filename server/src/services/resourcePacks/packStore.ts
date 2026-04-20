// Resource-pack JSON loader. Scans a directory of pack definitions and
// returns validated ResourcePack objects. Ports launcher's
// `base-controller.loadResourcePacks` as a standalone helper.

import fs from 'fs';
import path from 'path';
import { ResourceType, type ResourcePack } from '../../contracts/resourcePacks.contract.js';
import { paths } from '../../config/paths.js';
import { logger } from '../../lib/logger.js';

function definitionsDir(): string {
  return path.join(paths.dataDir, 'resource-packs');
}

function validateResource(r: Record<string, unknown>): boolean {
  if (typeof r.id !== 'string' || typeof r.name !== 'string' || typeof r.type !== 'string') return false;
  switch (r.type) {
    case ResourceType.MODEL: return Boolean(r.url && r.dir && r.out);
    case ResourceType.PLUGIN: return Boolean(r.github);
    case ResourceType.WORKFLOW: return Boolean(r.url && r.filename);
    case ResourceType.CUSTOM: return Boolean(r.url && r.destination);
    default: return false;
  }
}

function validatePack(pack: unknown): pack is ResourcePack {
  if (!pack || typeof pack !== 'object') return false;
  const p = pack as Record<string, unknown>;
  if (typeof p.id !== 'string' || typeof p.name !== 'string') return false;
  if (!Array.isArray(p.resources)) return false;
  return p.resources.every((r) => validateResource(r as Record<string, unknown>));
}

let cache: ResourcePack[] | null = null;

export function loadResourcePacks(): ResourcePack[] {
  if (cache) return cache;
  const dir = definitionsDir();
  const packs: ResourcePack[] = [];
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      cache = packs;
      return cache;
    }
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      const filePath = path.join(dir, file);
      try {
        const body = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(body) as unknown;
        if (validatePack(parsed)) packs.push(parsed);
        else logger.warn('resource pack validation failed', { file });
      } catch (err) {
        logger.warn('resource pack parse failed', {
          file, message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    logger.warn('resource pack load failed', { message: err instanceof Error ? err.message : String(err) });
  }
  cache = packs;
  return cache;
}

/** Test helper: forget cached packs. */
export function resetPackCache(): void { cache = null; }

/** Return a single pack by ID, or undefined. */
export function findPack(id: string): ResourcePack | undefined {
  return loadResourcePacks().find((p) => p.id === id);
}
