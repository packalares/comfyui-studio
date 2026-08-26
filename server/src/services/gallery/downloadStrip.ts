// Stream a metadata-stripped copy of a gallery file to the client.
//
// WHY strip metadata: ComfyUI embeds the full workflow JSON + prompt text
// in PNG tEXt chunks, FLAC Vorbis comments, EXIF UserComment, and MP4
// container atoms. Users downloading their output for external sharing
// should not inadvertently leak that data.
//
// This function does NOT touch /api/view — the raw-original endpoint stays
// untouched so internal callers (regenerate, thumbnail) keep working.

import path from 'path';
import { createReadStream } from 'fs';
import { spawn } from 'child_process';
import type { Response } from 'express';
import sharp, { type Sharp } from 'sharp';
import { logger } from '../../lib/logger.js';

// ffmpeg binary path — available in the deploy environment.
const FFMPEG_BIN = '/usr/bin/ffmpeg';

// Content-type map for the download response.
const CONTENT_TYPE: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.obj': 'model/obj',
  '.ply': 'application/octet-stream',
};

// ffmpeg output format flag per extension. Required for stdout piping
// because ffmpeg needs to know the container when writing to a pipe.
const FFMPEG_FORMAT: Record<string, string> = {
  '.flac': 'flac',
  '.wav': 'wav',
  '.mp3': 'mp3',
  '.ogg': 'ogg',
  '.opus': 'ogg',
  '.mp4': 'mp4',
  '.webm': 'webm',
  '.mov': 'mov',
  '.mkv': 'matroska',
};

// Extensions that carry zero ComfyUI metadata — stream the raw file as-is.
// GLB/GLTF/OBJ/PLY are 3D container formats that ComfyUI doesn't annotate.
const PASSTHROUGH_EXTS = new Set(['.glb', '.gltf', '.obj', '.ply']);

// GIF passthrough: sharp's animated GIF support is limited (requires
// libvips >= 8.12 with libimagequant). GIFs are also extremely unlikely
// to carry ComfyUI metadata since ComfyUI's SaveAnimatedWEBP outputs webp.
// Passthrough is safe here.
const GIF_PASSTHROUGH = true;

function ext(filename: string): string {
  return path.extname(filename).toLowerCase();
}

function setDownloadHeaders(res: Response, filename: string, contentType: string): void {
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-store');
}

// ── Image strip via sharp ─────────────────────────────────────────────────────

async function streamImageStripped(
  res: Response, filePath: string, filename: string, e: string,
): Promise<void> {
  // sharp drops EXIF/XMP/ICC/IPTC by default — no `.withMetadata()` call.
  // Each format re-encode removes the tEXt chunks (PNG) / EXIF UserComment
  // (JPEG/WebP) where ComfyUI embeds the prompt JSON.
  let pipeline: Sharp;
  if (e === '.png') {
    pipeline = sharp(filePath).png();
  } else if (e === '.jpg' || e === '.jpeg') {
    // quality 95 + mozjpeg: minimal quality regression on re-encode.
    pipeline = sharp(filePath).jpeg({ quality: 95, mozjpeg: true });
  } else if (e === '.webp') {
    pipeline = sharp(filePath).webp({ quality: 95 });
  } else {
    // GIF passthrough — see GIF_PASSTHROUGH comment above.
    if (GIF_PASSTHROUGH) {
      createReadStream(filePath).pipe(res);
      return;
    }
    pipeline = sharp(filePath, { animated: true }).gif();
  }
  try {
    const buf = await pipeline.toBuffer();
    res.setHeader('Content-Length', String(buf.byteLength));
    res.end(buf);
  } catch (err) {
    logger.warn('downloadStrip: sharp failed', {
      filename,
      error: err instanceof Error ? err.message : String(err),
    });
    if (!res.headersSent) {
      res.status(502).json({ error: 'image_strip_failed' });
    }
  }
}

// ── Audio/video strip via ffmpeg ──────────────────────────────────────────────

function streamAvStripped(
  res: Response, filePath: string, filename: string, e: string,
): Promise<void> {
  return new Promise((resolve) => {
    const format = FFMPEG_FORMAT[e] ?? 'matroska';
    const args = [
      '-i', filePath,
      '-c', 'copy',
      '-map_metadata', '-1',   // drop all container-level metadata
    ];
    // MP4 muxer doesn't support non-seekable output by default — without
    // movflags it fails with "muxer does not support non seekable output"
    // and writes zero bytes to stdout (the empty-file bug). Fragmented
    // MP4 (frag_keyframe + empty_moov + default_base_moof) IS streamable
    // and produces a valid file that browsers and players read fine.
    if (e === '.mp4') {
      args.push('-movflags', '+frag_keyframe+empty_moov+default_base_moof');
    }
    args.push('-f', format, 'pipe:1');

    const proc = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stderrChunks: Buffer[] = [];

    proc.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    // Clean up the subprocess if the client disconnects mid-stream to
    // avoid leaving a zombie ffmpeg process holding the file descriptor.
    res.on('close', () => {
      if (!proc.killed) proc.kill('SIGTERM');
    });

    proc.stdout.pipe(res);

    proc.on('close', (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim().slice(-400);
        logger.warn('downloadStrip: ffmpeg non-zero exit', { filename, code, stderr });
        if (!res.headersSent) {
          res.status(502).json({ error: 'ffmpeg_failed', detail: stderr });
        }
      }
      resolve();
    });

    proc.on('error', (err) => {
      logger.warn('downloadStrip: ffmpeg spawn error', {
        filename,
        error: err.message,
      });
      if (!res.headersSent) {
        res.status(502).json({ error: 'ffmpeg_unavailable' });
      }
      resolve();
    });
  });
}

// ── Public entry point ────────────────────────────────────────────────────────

export async function streamCleanDownload(
  res: Response,
  filePath: string,
  filename: string,
): Promise<void> {
  const e = ext(filename);
  const contentType = CONTENT_TYPE[e];

  if (!contentType) {
    res.status(415).json({ error: 'unsupported' });
    return;
  }

  setDownloadHeaders(res, filename, contentType);

  if (PASSTHROUGH_EXTS.has(e)) {
    createReadStream(filePath).pipe(res);
    return;
  }

  const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
  if (IMAGE_EXTS.has(e)) {
    await streamImageStripped(res, filePath, filename, e);
    return;
  }

  if (FFMPEG_FORMAT[e] != null) {
    await streamAvStripped(res, filePath, filename, e);
    return;
  }

  // Should be unreachable given CONTENT_TYPE guard above, but guard anyway.
  res.status(415).json({ error: 'unsupported' });
}
