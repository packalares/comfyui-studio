// Thin client for the docscanner service (UVDoc dewarp + OpenCV cleanup).
// Sends a base64 image to POST /scan/json and returns the cleaned base64.
// In-cluster, CPU, ~1-2 s/page. URL comes from settings (Tools → DocScanner);
// when unset, callers should treat image scanning as disabled.

import { getDocscannerUrl } from '../settings/index.js';
import { logger } from '../../lib/logger.js';

export class DocscannerError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'DocscannerError';
  }
}

export interface ScanResult { image_b64: string; format: string }

/**
 * Optimize one image (base64, no data: prefix) via docscanner.
 * @param config validated overrides forwarded to /scan/json (mode, sharpen, …).
 * @throws DocscannerError on any failure.
 */
export async function scanImage(
  base64: string,
  config: Record<string, unknown> = {},
  timeoutMs = 60_000,
): Promise<ScanResult> {
  const base = getDocscannerUrl();
  if (!base) throw new DocscannerError('docscanner_not_configured', 'DocScanner URL is not configured');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const r = await fetch(`${base}/scan/json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_b64: base64, ...config }),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new DocscannerError('docscanner_upstream', `DocScanner ${r.status}: ${body.slice(0, 200)}`);
    }
    const json = (await r.json()) as { image_b64?: string; format?: string };
    if (!json.image_b64) throw new DocscannerError('docscanner_empty', 'DocScanner returned no image');
    logger.info('docscanner scan ok', { ms: Date.now() - t0, format: json.format });
    return { image_b64: json.image_b64, format: json.format || 'png' };
  } catch (err) {
    if (err instanceof DocscannerError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new DocscannerError('docscanner_timeout', 'DocScanner timed out');
    }
    throw new DocscannerError('docscanner_error', err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}
