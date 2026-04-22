// Video pipeline: single-frame poster via ffmpeg, same behaviour as the
// legacy videoThumbnail.service. Frame 0 (`-ss 0 -vframes 1`) keeps
// sub-500ms clips from landing past EOF and writing a 0-byte webp.

import { spawn } from 'child_process';
import { unlinkSync } from 'fs';
import {
  cachePathForKey, localFileKey, peekCached, publishTmp,
} from '../cache.js';
import type { ThumbError, ThumbFileResult } from '../types.js';

const FFMPEG_TIMEOUT_MS = 15_000;

function runFfmpegFrameGrab(
  srcPath: string, width: number, tmpPath: string, finalPath: string,
): Promise<void> {
  // `-f webp` forces the muxer — ffmpeg's auto-detect keys off the output
  // filename extension and our `.webp.tmp` suffix otherwise errors out.
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-ss', '0',
    '-i', srcPath,
    '-vframes', '1',
    '-vf', `scale=${width}:-1`,
    '-q:v', '75',
    '-f', 'webp',
    tmpPath,
  ];
  return new Promise<void>((resolve, reject) => {
    let proc;
    try {
      proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch {
      reject({ code: 'FFMPEG_MISSING' } satisfies ThumbError);
      return;
    }
    let stderr = '';
    proc.stderr?.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    }, FFMPEG_TIMEOUT_MS);
    proc.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
      if (err.code === 'ENOENT') {
        reject({ code: 'FFMPEG_MISSING' } satisfies ThumbError);
        return;
      }
      reject({ code: 'FFMPEG_FAILED', detail: err.message } satisfies ThumbError);
    });
    proc.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (code === 0) {
        try {
          publishTmp(tmpPath, finalPath);
          resolve();
        } catch (err) {
          reject({
            code: 'FFMPEG_FAILED',
            detail: err instanceof Error ? err.message : String(err),
          } satisfies ThumbError);
        }
        return;
      }
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
      reject({
        code: 'FFMPEG_FAILED',
        detail: stderr.trim() || `ffmpeg exit ${code}`,
      } satisfies ThumbError);
    });
  });
}

export async function thumbnailForLocalVideo(
  absPath: string, width: number,
): Promise<ThumbFileResult> {
  const key = localFileKey(absPath, width);
  const hit = peekCached(key);
  if (hit) return { kind: 'file', filePath: hit, contentType: 'image/webp', cached: true };
  const { tmpPath, filePath } = cachePathForKey(key);
  await runFfmpegFrameGrab(absPath, width, tmpPath, filePath);
  return { kind: 'file', filePath, contentType: 'image/webp', cached: false };
}
