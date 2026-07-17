// Scan primitives and shared-hub resolver.
//
// Kept separate from install.ts so that modelIndex.ts can import these
// without closing a cycle (install.ts imports modelIndex for ensureFresh;
// modelIndex.ts imports scanDirectory + getSharedModelHubRoot from here).

import fs from 'fs';
import path from 'path';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

// ── Shared model hub ──────────────────────────────────────────────────────────

/** ComfyUI `models/<topDir>` to hub `<subdir>` mapping. */
export const COMFY_DIR_TO_HUB_SUBDIR: Readonly<Record<string, string>> = {
  checkpoints: 'main',
  loras: 'lora',
  vae: 'vae',
  embeddings: 'embeddings',
  hypernetworks: 'hypernetworks',
  clip: 'clip',
  clip_vision: 'clip_vision',
  controlnet: 'controlnet',
  inpaint: 'inpaint',
  upscale_models: 'upscale_models',
  ipadapter: 'ipadapter',
  unet: 'unet',
  style_models: 'style_models',
  facerestore_models: 'facerestore_models',
  diffusion_models: 'diffusion_models',
  text_encoders: 'text_encoders',
};

/** Mount point for the shared model tree, or empty string when unset. */
export function getSharedModelHubRoot(): string {
  return (env.SHARED_MODEL_HUB_PATH || '').trim();
}

/** Hub subdirectory for a given ComfyUI top-level dir (falls back to identity). */
export function hubSubdirForComfyTopDir(topDir: string): string {
  return COMFY_DIR_TO_HUB_SUBDIR[topDir] || topDir;
}

/**
 * Resolve a model file: try local ComfyUI models tree first, then shared hub.
 * Returns the absolute path of the first match or `null` if nothing exists.
 */
export function resolveModelFilePath(
  modelsRoot: string,
  dirRelative: string,
  outFile: string,
): string | null {
  const local = path.join(modelsRoot, dirRelative, outFile);
  if (fs.existsSync(local)) return local;

  const hubRoot = getSharedModelHubRoot();
  if (!hubRoot || !fs.existsSync(hubRoot)) return null;

  const segments = dirRelative.split(/[/\\]/).filter(Boolean);
  if (segments.length === 0) return null;
  const top = segments[0];
  const rest = segments.slice(1);
  const hubTop = hubSubdirForComfyTopDir(top);
  const hubPath = path.join(hubRoot, hubTop, ...rest, outFile);
  if (fs.existsSync(hubPath)) return hubPath;
  return null;
}

// ── Directory scanner ─────────────────────────────────────────────────────────

export interface ScanInfo {
  path: string;
  filename: string;
  size: number;
  status: 'complete' | 'incomplete' | 'corrupted' | 'unknown';
  type: string;
}

export const MODEL_EXTS = new Set(['.safetensors', '.ckpt', '.pth', '.pt', '.bin', '.onnx', '.gguf']);

/**
 * Recursively walk `dir` and accumulate model files into `result`.
 *
 * `rootForRelative !== null`: entries are keyed by path relative to that root
 * (ComfyUI install). When null (shared hub), the absolute path is used as key.
 *
 * Keying by the relative path (not basename) preserves distinct files that
 * share a basename, e.g. 17+ HF ControlNets all named
 * `diffusion_pytorch_model.safetensors`.
 */
export async function scanDirectory(
  dir: string,
  result: Map<string, ScanInfo>,
  rootForRelative: string | null,
): Promise<void> {
  try {
    const files = await fs.promises.readdir(dir);
    for (const file of files) {
      // Skip dot-directories (.cache, .git, etc.) — avoids symlink loops
      // inside HF snapshot blobs and duplicate index entries (audit C6).
      // Use lstat so we inspect the symlink itself, not its target.
      if (file.startsWith('.')) continue;
      const fullPath = path.join(dir, file);
      const stat = await fs.promises.lstat(fullPath);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        await scanDirectory(fullPath, result, rootForRelative);
        continue;
      }
      const ext = path.extname(file).toLowerCase();
      if (!MODEL_EXTS.has(ext)) continue;
      const info = await checkFileIntegrity(fullPath, file, stat.size);
      const storePath = rootForRelative !== null
        ? path.relative(rootForRelative, fullPath)
        : fullPath;
      result.set(storePath, {
        path: storePath,
        filename: file,
        size: stat.size,
        status: info.status,
        type: inferType(storePath),
      });
    }
  } catch (err) {
    logger.error('scan dir failed', {
      dir,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

async function checkFileIntegrity(
  filePath: string,
  fileName: string,
  fileSize: number,
): Promise<{ status: ScanInfo['status']; message?: string }> {
  try {
    if (fileSize === 0) return { status: 'incomplete', message: 'file size is 0' };
    const fh = await fs.promises.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(1024);
      const { bytesRead } = await fh.read(buffer, 0, 1024, 0);
      if (bytesRead <= 0) return { status: 'corrupted', message: 'unreadable' };
      return { status: 'complete' };
    } finally {
      await fh.close();
    }
  } catch (err) {
    logger.error('file integrity check failed', {
      fileName,
      message: err instanceof Error ? err.message : String(err),
    });
    return { status: 'corrupted', message: 'file not accessible' };
  }
}

// Keep the type-inference heuristic visible to match launcher 1:1.
export function inferType(relativePath: string): string {
  const p = relativePath.toLowerCase();
  if (p.includes('checkpoints') || p.includes('/main/')) return 'checkpoint';
  if (p.includes('loras') || p.includes('/lora/')) return 'lora';
  if (p.includes('vae')) return 'vae';
  if (p.includes('controlnet')) return 'controlnet';
  if (p.includes('upscale')) return 'upscaler';
  if (p.includes('embeddings')) return 'embedding';
  if (p.includes('inpaint')) return 'inpaint';
  if (p.includes('diffusion_models') || p.includes('/unet/')) return 'checkpoint';
  if (p.includes('clip_vision')) return 'checkpoint';
  if (p.includes('text_encoders') || p.includes('/clip/')) return 'checkpoint';
  return 'unknown';
}
