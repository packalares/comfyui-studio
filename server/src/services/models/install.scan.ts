// Directory-walk helper for the install scanner. Split out of
// `install.service.ts` to keep files under the 250-line cap.

import fs from 'fs';
import path from 'path';
import { logger } from '../../lib/logger.js';

export interface ScanInfo {
  path: string;
  filename: string;
  size: number;
  status: 'complete' | 'incomplete' | 'corrupted' | 'unknown';
  type: string;
}

const MODEL_EXTS = new Set(['.safetensors', '.ckpt', '.pth', '.pt', '.bin']);

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
      const fullPath = path.join(dir, file);
      const stat = await fs.promises.stat(fullPath);
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
function inferType(relativePath: string): string {
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
