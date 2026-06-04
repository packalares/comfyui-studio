// Cached snapshot of ComfyUI's `/api/experiment/models` response. The response
// shape:
//   [{ name: 'text_encoders', folders: ['/root/ComfyUI/models/text_encoders',
//                                       '/root/ComfyUI/models/clip', ...] }, ...]
//
// `name` is the canonical folder Studio uses everywhere (`save_path` field on
// catalog rows, type derivation, etc.). The `folders` array lists every
// physical path ComfyUI walks for that logical folder — and is the source of
// truth for aliases (a path whose basename ≠ name is an alias, e.g.
// `models/clip/` for `text_encoders`).
//
// Output / temp dirs are filtered out at load time: ComfyUI registers
// `output/<folder>` for save-back workflows, but treating generated artifacts
// as installed models is wrong. The filter is a single regex applied to every
// folder of every type.

import * as fs from 'fs';
import * as path from 'path';
import { getRegisteredFolders } from '../comfyui/api.js';
import { logger } from '../../lib/logger.js';

interface RegistryState {
  knownFolders: Set<string>;
  aliasMap: Map<string, string>;
  pathsForFolder: Map<string, string[]>;
  loadedAt: number;
}

let state: RegistryState = {
  knownFolders: new Set(),
  aliasMap: new Map(),
  pathsForFolder: new Map(),
  loadedAt: 0,
};

const REFRESH_AFTER_MS = 60 * 1000;

// Filter applied to every `folders[]` entry. Output + temp dirs are excluded
// because ComfyUI also registers those for "save model → reload" workflows;
// files there are runtime artifacts, not installed models.
function isModelsRoot(absPath: string): boolean {
  return !/(^|\/)(output|temp)\//.test(absPath);
}

/** Pulls `/api/experiment/models`, populates the in-memory registry.
 *  Idempotent — call freely at boot + after rescan. */
export async function refreshRegistry(force = false): Promise<void> {
  if (!force && Date.now() - state.loadedAt < REFRESH_AFTER_MS) return;
  try {
    const list = await getRegisteredFolders();
    const next: RegistryState = {
      knownFolders: new Set(),
      aliasMap: new Map(),
      pathsForFolder: new Map(),
      loadedAt: Date.now(),
    };
    for (const entry of list) {
      next.knownFolders.add(entry.name);
      const installPaths = entry.folders.filter(isModelsRoot);
      next.pathsForFolder.set(entry.name, installPaths);
      for (const folderPath of installPaths) {
        const basename = path.basename(folderPath);
        if (basename !== entry.name) {
          next.aliasMap.set(basename, entry.name);
        }
      }
    }
    state = next;
    logger.info('folderRegistry: refreshed', {
      folderCount: state.knownFolders.size,
      aliasCount: state.aliasMap.size,
    });
  } catch (err) {
    logger.warn('folderRegistry: refresh failed', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Set of folder names ComfyUI currently knows about (core + custom_node-registered). */
export function getKnownFolders(): Set<string> {
  return state.knownFolders;
}

/** Resolve an alias to its canonical name. Returns the input unchanged when
 *  it's already canonical or unknown. */
export function canonicalFolderName(name: string): string {
  if (!name) return name;
  const segments = name.split('/');
  const top = segments[0];
  const canonical = state.aliasMap.get(top);
  if (!canonical) return name;
  segments[0] = canonical;
  return segments.join('/');
}

/** Static list of ComfyUI core folder names (from folder_paths.py).
 *  Custom-node-registered folders show up in `knownFolders` from the API. */
const CORE_FOLDERS = new Set([
  'checkpoints', 'configs', 'loras', 'vae', 'text_encoders', 'diffusion_models',
  'clip_vision', 'style_models', 'embeddings', 'diffusers', 'vae_approx',
  'controlnet', 'gligen', 'upscale_models', 'latent_upscale_models',
  'hypernetworks', 'photomaker', 'classifiers', 'model_patches',
  'audio_encoders', 'frame_interpolation',
]);

export type FolderKind = 'core' | 'custom_node' | 'unregistered';

/** Classify a folder name. `unregistered` typically means the custom_node that
 *  would have registered it isn't installed yet — callers should preserve the
 *  row and surface a "pending node install" hint in the UI. */
export function classifyFolder(name: string): FolderKind {
  if (!name) return 'unregistered';
  const top = canonicalFolderName(name).split('/')[0];
  if (CORE_FOLDERS.has(top)) return 'core';
  if (state.knownFolders.has(top)) return 'custom_node';
  return 'unregistered';
}

/** Get every physical path ComfyUI scans for the given logical folder.
 *  Useful for the disk-truth lookup. */
export function getPathsForFolder(name: string): string[] {
  return state.pathsForFolder.get(canonicalFolderName(name).split('/')[0]) ?? [];
}

/** Walk every known folder root looking for a file by basename. First match
 *  wins. Returns the canonical folder name + the absolute path on disk.
 *  Bounded recursion (max depth 4) to keep boot fast. */
export async function findFileOnDisk(
  basename: string,
): Promise<{ folder: string; absPath: string; subPath: string } | null> {
  for (const [folder, paths] of state.pathsForFolder.entries()) {
    for (const root of paths) {
      if (!fs.existsSync(root)) continue;
      const found = await walkForFile(root, basename, 0);
      if (found) {
        const rel = path.relative(root, path.dirname(found));
        return {
          folder,
          absPath: found,
          subPath: rel,
        };
      }
    }
  }
  return null;
}

async function walkForFile(dir: string, basename: string, depth: number): Promise<string | null> {
  if (depth > 4) return null;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (e.isFile() && e.name === basename) return path.join(dir, e.name);
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.') || e.name === '__pycache__') continue;
    const hit = await walkForFile(path.join(dir, e.name), basename, depth + 1);
    if (hit) return hit;
  }
  return null;
}
