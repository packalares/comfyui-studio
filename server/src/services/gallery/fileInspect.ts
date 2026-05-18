// File inspection helper shared by both the live pipeline and disk-sweep paths.
// Centralised here so probes (sharp for images, ffprobe for video/audio) have
// a single entry point.

import { stat } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import sharp from 'sharp';

export interface FileInspection {
  sizeBytes: number;
  /** File modification time in ms since epoch — used by disk-sweep for createdAt. */
  mtimeMs: number;
  /** Media playback duration in ms; null for images and unprobed files. */
  mediaDurationMs?: number;
  /** Dimensions / codec info from sharp or ffprobe. */
  mediaInfo?: Record<string, unknown>;
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'tiff', 'bmp']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'mkv', 'm4v']);
const AUDIO_EXTS = new Set(['flac', 'wav', 'mp3', 'ogg', 'm4a', 'aac', 'opus']);

function extOf(absPath: string): string {
  return path.extname(absPath).replace(/^\./, '').toLowerCase();
}

async function probeImage(absPath: string): Promise<Partial<FileInspection>> {
  try {
    const meta = await sharp(absPath).metadata();
    const mediaInfo: Record<string, unknown> = {};
    if (meta.width != null) mediaInfo.width = meta.width;
    if (meta.height != null) mediaInfo.height = meta.height;
    if (meta.format != null) mediaInfo.format = meta.format;
    if (meta.channels != null) mediaInfo.channels = meta.channels;
    if (meta.hasAlpha != null) mediaInfo.hasAlpha = meta.hasAlpha;
    return Object.keys(mediaInfo).length > 0 ? { mediaInfo } : {};
  } catch {
    return {};
  }
}

/** Run ffprobe with a 5-second timeout; parse JSON output. */
function runFfprobe(absPath: string): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const child = spawn(
      'ffprobe',
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', absPath],
      { signal: controller.signal },
    );
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || !stdout) { resolve(null); return; }
      try { resolve(JSON.parse(stdout) as Record<string, unknown>); }
      catch { resolve(null); }
    });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
  });
}

async function probeVideo(absPath: string): Promise<Partial<FileInspection>> {
  try {
    const probe = await runFfprobe(absPath);
    if (!probe) return {};
    const format = probe.format as Record<string, unknown> | undefined;
    const streams = Array.isArray(probe.streams) ? probe.streams as unknown[] : [];
    const mediaInfo: Record<string, unknown> = {};
    let mediaDurationMs: number | undefined;
    if (typeof format?.duration === 'string') {
      const sec = parseFloat(format.duration);
      if (Number.isFinite(sec) && sec > 0) mediaDurationMs = Math.round(sec * 1000);
    }
    const videoStream = streams.find(
      s => (s as Record<string, unknown>).codec_type === 'video',
    ) as Record<string, unknown> | undefined;
    if (videoStream) {
      if (videoStream.width != null) mediaInfo.width = videoStream.width;
      if (videoStream.height != null) mediaInfo.height = videoStream.height;
      if (videoStream.codec_name != null) mediaInfo.codec_name = videoStream.codec_name;
      if (videoStream.pix_fmt != null) mediaInfo.pix_fmt = videoStream.pix_fmt;
      if (typeof videoStream.r_frame_rate === 'string') {
        const parts = (videoStream.r_frame_rate as string).split('/');
        if (parts.length === 2) {
          const num = parseFloat(parts[0]!);
          const den = parseFloat(parts[1]!);
          if (Number.isFinite(num) && Number.isFinite(den) && den !== 0) {
            mediaInfo.fps = Math.round((num / den) * 1000) / 1000;
          }
        }
      }
    }
    return {
      ...(mediaDurationMs != null ? { mediaDurationMs } : {}),
      ...(Object.keys(mediaInfo).length > 0 ? { mediaInfo } : {}),
    };
  } catch {
    return {};
  }
}

async function probeAudio(absPath: string): Promise<Partial<FileInspection>> {
  try {
    const probe = await runFfprobe(absPath);
    if (!probe) return {};
    const format = probe.format as Record<string, unknown> | undefined;
    const streams = Array.isArray(probe.streams) ? probe.streams as unknown[] : [];
    const audioStream = streams.find(
      s => (s as Record<string, unknown>).codec_type === 'audio',
    ) as Record<string, unknown> | undefined;
    const mediaInfo: Record<string, unknown> = {};
    let mediaDurationMs: number | undefined;
    if (typeof format?.duration === 'string') {
      const sec = parseFloat(format.duration);
      if (Number.isFinite(sec) && sec > 0) mediaDurationMs = Math.round(sec * 1000);
    }
    if (audioStream) {
      if (audioStream.codec_name != null) mediaInfo.codec_name = audioStream.codec_name;
      if (audioStream.sample_rate != null) mediaInfo.sample_rate = audioStream.sample_rate;
      if (audioStream.channels != null) mediaInfo.channels = audioStream.channels;
      if (audioStream.bit_rate != null) mediaInfo.bit_rate = audioStream.bit_rate;
    }
    return {
      ...(mediaDurationMs != null ? { mediaDurationMs } : {}),
      ...(Object.keys(mediaInfo).length > 0 ? { mediaInfo } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * Stat a file and return basic + optional media inspection data. Returns null
 * when the file is missing, unreadable, or zero bytes (zero-byte files indicate
 * a failed write and should be excluded from the gallery).
 *
 * Media probes (sharp / ffprobe) run only for known extensions. Probe errors
 * are silently swallowed — the row still gets sizeBytes.
 */
export async function inspectFile(absPath: string): Promise<FileInspection | null> {
  try {
    const s = await stat(absPath);
    if (s.size === 0) return null;
    const base: FileInspection = { sizeBytes: s.size, mtimeMs: s.mtimeMs };
    const ext = extOf(absPath);
    let probe: Partial<FileInspection> = {};
    if (IMAGE_EXTS.has(ext)) {
      probe = await probeImage(absPath);
    } else if (VIDEO_EXTS.has(ext)) {
      probe = await probeVideo(absPath);
    } else if (AUDIO_EXTS.has(ext)) {
      probe = await probeAudio(absPath);
    }
    return { ...base, ...probe };
  } catch {
    return null;
  }
}
