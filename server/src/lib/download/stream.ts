// Response-side stream handlers for the download engine.
//
// Split out of `engine.ts` to keep each file under the 250-line cap.
// The engine owns the HEAD / request orchestration; this module is purely
// about "once the response headers are in, do the right thing".
import fs from 'fs';
import http from 'http';
import { logger } from '../logger.js';
import type {
  DownloadOptions,
  DownloadProgress,
} from '../../contracts/models.contract.js';
import {
  isRedirectStatus,
  parseContentLength,
  parseContentRangeTotal,
  resolveRedirectUrl,
} from './httpRanges.js';

/** Socket idle timeout (ms). */
export const SOCKET_TIMEOUT = 60_000;

export interface InnerState {
  url: string;
  destPath: string;
  tempPath: string;
  startBytes: number;
  options: DownloadOptions;
  tracker?: DownloadProgress;
  onProgress: ProgressCb;
}

export type ProgressCb = (
  progress: number,
  downloadedBytes: number,
  totalBytes: number,
) => boolean | void;

export interface StreamCtx {
  s: InnerState;
  req: http.ClientRequest;
  res: http.IncomingMessage;
  finalUrl: string;
  initialTotal: number;
  resolve: (v: boolean) => void;
  safeReject: (e: Error) => void;
  /** Recursive downloader entry (provided by engine to avoid a cycle). */
  reenter: (url: string, skipHead: boolean) => Promise<boolean>;
}

/** Dispatch on the incoming response; handles 416, redirects, then streams. */
export function attachResponseHandlers(ctx: StreamCtx): void {
  const { res, req } = ctx;
  logger.info('download response', { statusCode: res.statusCode });
  if (res.statusCode === 416) return handle416(ctx);
  if (isRedirectStatus(res.statusCode)) return handleGetRedirect(ctx);
  if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
    ctx.safeReject(new Error(`HTTP ${res.statusCode}`));
    return;
  }
  const total = computeTotalBytes(ctx);
  if (res.socket) {
    res.socket.setTimeout(SOCKET_TIMEOUT);
    res.socket.on('timeout', () => {
      logger.error('download socket timeout', { timeoutMs: SOCKET_TIMEOUT });
      res.removeAllListeners('data');
      res.removeAllListeners('end');
      res.removeAllListeners('error');
      res.socket?.destroy();
      req.destroy();
      ctx.safeReject(new Error(`socket timeout after ${SOCKET_TIMEOUT}ms`));
    });
  }
  pipeToTempFile(ctx, total);
  if (ctx.s.tracker) ctx.s.tracker.totalBytes = total || ctx.s.tracker.totalBytes;
}

function computeTotalBytes(ctx: StreamCtx): number {
  const { s, res, initialTotal } = ctx;
  let total = s.tracker?.totalBytes || initialTotal || 0;
  const cl = parseContentLength(res.headers['content-length']);
  if (cl > 0) {
    total = s.startBytes > 0 && res.statusCode === 206 ? s.startBytes + cl : cl;
  }
  const rangeTotal = parseContentRangeTotal(res.headers['content-range'] as string | undefined);
  if (rangeTotal) total = rangeTotal;
  return total;
}

function handle416(ctx: StreamCtx): void {
  const { s } = ctx;
  logger.info('download 416 range not satisfiable; treating as complete');
  if (fs.existsSync(s.tempPath)) fs.renameSync(s.tempPath, s.destPath);
  if (s.tracker) {
    s.tracker.currentModelProgress = 100;
    s.tracker.overallProgress = 100;
    s.tracker.totalBytes = s.startBytes;
    s.tracker.downloadedBytes = s.startBytes;
    s.tracker.completed = true;
  }
  s.onProgress(100, s.startBytes, s.startBytes);
  ctx.resolve(true);
}

function handleGetRedirect(ctx: StreamCtx): void {
  const { res, req, finalUrl } = ctx;
  const location = res.headers.location;
  if (!location) { ctx.safeReject(new Error(`redirect ${res.statusCode} missing location`)); return; }
  const resolved = resolveRedirectUrl(location, finalUrl);
  logger.info('download GET redirect', { location: resolved });
  req.destroy();
  res.resume();
  ctx.reenter(resolved, true).then(ctx.resolve).catch(ctx.safeReject);
}

function pipeToTempFile(ctx: StreamCtx, total: number): void {
  const { s, res, req } = ctx;
  const fileStream = fs.createWriteStream(s.tempPath, { flags: s.startBytes > 0 ? 'a' : 'w' });
  let downloaded = s.startBytes;
  res.on('data', (chunk: Buffer) => {
    if (s.options.abortController?.signal.aborted) {
      req.destroy(); fileStream.end();
      ctx.safeReject(new Error('download canceled'));
      return;
    }
    fileStream.write(chunk);
    downloaded += chunk.length;
    if (s.tracker) {
      s.tracker.downloadedBytes = downloaded;
      // Throttled 500ms-window speed (bytes/sec). Uses fields initTracker set up.
      const now = Date.now();
      const since = now - (s.tracker.lastUpdateTime ?? s.tracker.startTime ?? now);
      if (since >= 500) {
        const delta = downloaded - (s.tracker.lastBytes ?? s.startBytes);
        s.tracker.speed = (delta * 1000) / Math.max(since, 1);
        s.tracker.lastUpdateTime = now;
        s.tracker.lastBytes = downloaded;
      }
    }
    const percent = total > 0 ? Math.round((downloaded / total) * 100) : 0;
    if (s.tracker) { s.tracker.currentModelProgress = percent; s.tracker.overallProgress = percent; }
    const keep = s.onProgress(percent, downloaded, total);
    if (keep === false) {
      req.destroy(); fileStream.end();
      ctx.safeReject(new Error('download canceled by callback'));
    }
  });
  res.on('end', () => {
    if (s.options.abortController?.signal.aborted) {
      fileStream.end(); ctx.safeReject(new Error('download canceled')); return;
    }
    fileStream.end(() => {
      try { if (fs.existsSync(s.tempPath)) fs.renameSync(s.tempPath, s.destPath); } catch (err) {
        logger.error('download rename failed', { message: err instanceof Error ? err.message : String(err) });
      }
      logger.info('download complete', { url: s.url, size: downloaded });
      ctx.resolve(true);
    });
  });
  res.on('error', (err) => {
    fileStream.end();
    logger.error('download response error', { message: err.message });
    ctx.safeReject(err);
  });
}
