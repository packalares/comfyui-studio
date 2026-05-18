// Resumable single-file downloader absorbed from launcher's
// `utils/download.utils.ts`.
//
// Preserves the launcher's behaviour exactly:
// - HEAD pre-flight (unless `skipHeadRequest` is set on a redirect follow-up).
// - Resume via Range header when a `.download` temp file exists.
// - Follows 3xx redirects by re-invoking the engine with `skipHeadRequest=true`.
// - 416 is treated as "already complete" and renames the temp file.
// - Idle data-receive timeout + socket timeout both abort the request.
// - `onProgress` returning `false` cancels the transfer.
//
// Translated from Chinese comments/log strings; no i18n.
import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
import { logger } from '../logger.js';
import type {
  DownloadOptions,
  DownloadProgress,
} from '../../contracts/models.contract.js';
import {
  isRedirectStatus,
  parseContentLength,
  resolveRedirectUrl,
} from './httpRanges.js';
import { attachResponseHandlers } from './stream.js';
import type { InnerState, ProgressCb, StreamCtx } from './stream.js';

/** 30s for establishing a connection. */
const REQUEST_TIMEOUT = 30_000;

/**
 * Download `url` to `destPath`, resuming from any existing `.download` temp
 * file. `skipHeadRequest` is `true` only when called recursively to follow
 * a redirect.
 */
export async function downloadFile(
  url: string,
  destPath: string,
  onProgress: ProgressCb,
  options: DownloadOptions,
  progressTracker?: DownloadProgress,
  skipHeadRequest = false,
): Promise<boolean> {
  logger.info('download start', { url, destPath });
  ensureDir(destPath);
  const tempPath = `${destPath}.download`;
  const startBytes = existingTempSize(tempPath);
  if (startBytes > 0) logger.info('download resume found', { size: startBytes });
  initTracker(progressTracker, startBytes);

  if (options.abortController?.signal.aborted) {
    logger.info('download canceled before start', { url });
    return false;
  }

  const state: InnerState = {
    url, destPath, tempPath, startBytes, options,
    tracker: progressTracker, onProgress,
  };
  if (skipHeadRequest) {
    const totalBytes = progressTracker?.totalBytes || 0;
    return runGet(state, totalBytes, url);
  }
  return runHeadThenGet(state);
}

function ensureDir(destPath: string): void {
  const dir = path.dirname(destPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function existingTempSize(tempPath: string): number {
  if (!fs.existsSync(tempPath)) return 0;
  const stat = fs.statSync(tempPath);
  return stat.size > 0 ? stat.size : 0;
}

function initTracker(t: DownloadProgress | undefined, startBytes: number): void {
  if (!t) return;
  t.startBytes = startBytes;
  t.downloadedBytes = startBytes;
  t.startTime = Date.now();
  t.lastUpdateTime = Date.now();
  t.lastBytes = startBytes;
}

function httpClientFor(url: string): typeof http | typeof https {
  return url.startsWith('https:') ? https : http;
}

function authHeadersFor(options: DownloadOptions): Record<string, string> {
  return options.authHeaders || {};
}

/** Lowercase hostname, or empty string if the URL is malformed. */
function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

/**
 * Strip Authorization when the request URL's host differs from the original.
 * Mirrors fetch's default `redirect: 'follow'` behaviour, which strips
 * Authorization on cross-host redirects.
 *
 * Without this, a caller-supplied Bearer leaks onto pre-signed CDN URLs
 * (S3, R2, CloudFront) that CivitAI / HF LFS / GitHub release downloads
 * redirect into. Those URLs carry their own AWS-Sig-V4 auth in the query
 * string and reject foreign Bearer tokens with 400 Bad Request.
 *
 * Exported for unit testing; engine helpers below wrap it for InnerState.
 */
export function filterAuthHeadersForHost(
  headers: Record<string, string> | undefined,
  originalUrl: string,
  requestUrl: string,
): Record<string, string> {
  const all = headers || {};
  if (!all.Authorization) return all;
  const origHost = hostOf(originalUrl);
  const reqHost = hostOf(requestUrl);
  if (origHost && reqHost && origHost === reqHost) return all;
  const { Authorization: _drop, ...rest } = all;
  return rest;
}

function authHeadersForRequest(
  s: InnerState, requestUrl: string,
): Record<string, string> {
  return filterAuthHeadersForHost(authHeadersFor(s.options), s.url, requestUrl);
}

/** Strip Authorization from a DownloadOptions copy for cross-host re-entry. */
function optionsWithoutAuth(options: DownloadOptions): DownloadOptions {
  const ah = options.authHeaders;
  if (!ah || !ah.Authorization) return options;
  const { Authorization: _drop, ...rest } = ah;
  return { ...options, authHeaders: rest };
}

/** Send a HEAD request to discover size; recurse through redirects; then GET. */
function runHeadThenGet(s: InnerState): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const client = httpClientFor(s.url);
    const headOptions: http.RequestOptions = {
      method: 'HEAD',
      headers: { ...authHeadersFor(s.options) },
      signal: s.options.abortController?.signal,
      timeout: REQUEST_TIMEOUT,
    };
    logger.info('download HEAD request', { url: s.url });
    const req = client.request(s.url, headOptions, (res) => {
      if (isRedirectStatus(res.statusCode)) {
        const location = res.headers.location;
        if (!location) {
          reject(new Error(`redirect status ${res.statusCode} missing location header`));
          return;
        }
        const resolved = resolveRedirectUrl(location, s.url);
        logger.info('download HEAD redirect', { location: resolved });
        res.resume();
        res.on('end', () => { runGet(s, 0, resolved).then(resolve).catch(reject); });
        return;
      }
      const total = parseContentLength(res.headers['content-length']);
      if (total > 0 && s.tracker) s.tracker.totalBytes = total;
      res.resume();
      res.on('end', () => { runGet(s, total, s.url).then(resolve).catch(reject); });
    });
    req.on('error', (err) => {
      logger.warn('download HEAD error', { message: err.message });
      runGet(s, 0, s.url).then(resolve).catch(reject);
    });
    req.on('timeout', () => {
      logger.warn('download HEAD timeout', { timeoutMs: REQUEST_TIMEOUT });
      req.destroy();
      runGet(s, 0, s.url).then(resolve).catch(reject);
    });
    req.end();
  });
}

/** Issue the GET; if the response is obviously complete, short-circuit. */
function runGet(s: InnerState, totalBytes: number, finalUrl: string): Promise<boolean> {
  if (totalBytes > 1_000_000 && s.startBytes >= totalBytes) {
    return shortCircuitComplete(s, totalBytes);
  }
  const headers: Record<string, string> = { ...authHeadersForRequest(s, finalUrl) };
  if (s.startBytes > 0) headers.Range = `bytes=${s.startBytes}-`;
  const reqOpts: http.RequestOptions = {
    method: 'GET',
    headers,
    signal: s.options.abortController?.signal,
    timeout: REQUEST_TIMEOUT,
  };
  return streamGet(s, finalUrl, reqOpts, totalBytes);
}

function shortCircuitComplete(s: InnerState, totalBytes: number): Promise<boolean> {
  logger.info('download already complete', { downloaded: s.startBytes, total: totalBytes });
  if (fs.existsSync(s.tempPath)) fs.renameSync(s.tempPath, s.destPath);
  if (s.tracker) {
    s.tracker.currentModelProgress = 100;
    s.tracker.overallProgress = 100;
    s.tracker.totalBytes = totalBytes;
    s.tracker.downloadedBytes = totalBytes;
    s.tracker.completed = true;
  }
  s.onProgress(100, totalBytes, totalBytes);
  return Promise.resolve(true);
}

function streamGet(
  s: InnerState,
  finalUrl: string,
  reqOpts: http.RequestOptions,
  initialTotal: number,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const client = httpClientFor(finalUrl);
    let rejected = false;
    const safeReject = (err: Error) => { if (!rejected) { rejected = true; reject(err); } };
    const req = client.request(finalUrl, reqOpts, (res) => {
      const ctx: StreamCtx = {
        s, req, res, finalUrl, initialTotal, resolve, safeReject,
        reenter: (url, skipHead) => {
        // If the redirect points at a different host, drop Authorization
        // before re-entering. The recursive frame's `s.url` becomes the
        // new URL, so `authHeadersForRequest` would otherwise see
        // same-host and pass the original Bearer through.
        const opts = hostOf(s.url) === hostOf(url) ? s.options : optionsWithoutAuth(s.options);
        return downloadFile(url, s.destPath, s.onProgress, opts, s.tracker, skipHead);
      },
      };
      attachResponseHandlers(ctx);
    });
    req.on('error', (err) => {
      if (s.options.abortController?.signal.aborted) {
        safeReject(new Error('download canceled'));
      } else {
        logger.error('download GET error', { message: err.message });
        safeReject(err);
      }
    });
    req.on('timeout', () => {
      logger.error('download request timeout', { timeoutMs: REQUEST_TIMEOUT });
      req.destroy();
      safeReject(new Error(`request timeout after ${REQUEST_TIMEOUT}ms`));
    });
    req.end();
  });
}
