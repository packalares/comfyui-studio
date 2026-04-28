// Allow-list for the unified `/models/download-custom` endpoint.
//
// Built-in hosts are HF / hf-mirror / civitai / github (canonical + www
// variants). Operator-added hosts come from
// `liveSettings.getModelTrustedHosts()` so an operator can extend the
// allow-list at runtime via the Settings UI without redeploying.

import { hostIsPrivate, isHttpUrl } from '../../routes/models.validation.js';
import { getModelTrustedHosts } from '../systemLauncher/liveSettings.js';

const BUILTIN_DOWNLOAD_HOSTS: ReadonlySet<string> = new Set([
  'huggingface.co', 'www.huggingface.co', 'hf-mirror.com',
  'civitai.com', 'www.civitai.com',
  'github.com', 'www.github.com',
]);

/** Live read so operator-added hosts apply without restart. */
function liveAllowedHosts(): Set<string> {
  const out = new Set<string>(BUILTIN_DOWNLOAD_HOSTS);
  for (const h of getModelTrustedHosts()) out.add(h);
  return out;
}

export function isAllowedDownloadHost(url: string): boolean {
  try {
    return liveAllowedHosts().has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export interface AllowedUrlResult {
  ok: boolean;
  /** Error message suitable for a 400 response when ok=false. */
  error?: string;
}

/**
 * One-stop validator for the unified-download endpoint:
 *   - http(s) only.
 *   - Hostname not on the SSRF private-IP set.
 *   - Hostname on the allow-list (built-ins ∪ live operator additions).
 */
export function validateAllowedUrl(url: string): AllowedUrlResult {
  if (!isHttpUrl(url)) return { ok: false, error: 'hfUrl must be http(s)' };
  if (hostIsPrivate(url)) return { ok: false, error: 'hfUrl points at a private/loopback host' };
  if (!isAllowedDownloadHost(url)) {
    return { ok: false, error: 'hfUrl host not allowed (huggingface.co, hf-mirror.com, civitai.com, github.com, or an operator-trusted host)' };
  }
  return { ok: true };
}

/**
 * Detect whether the URL is a civitai-style host that does not encode a
 * filename in its path. The route handler uses this to decide whether to
 * require an explicit `filename` body field.
 */
export function urlEncodesFilename(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host !== 'civitai.com' && host !== 'www.civitai.com';
  } catch {
    return false;
  }
}
