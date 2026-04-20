// URL validation for plugin install. Enforces:
//   - https:// scheme only.
//   - Hostname on the allow-list (github.com / gitlab.com / huggingface.co
//     plus anything in liveSettings.getPluginTrustedHosts()).
//   - Hostname not in the SSRF-dangerous private-IP set.
//
// Called by install.service.ts BEFORE any git clone or file fetch happens.
// Reads from liveSettings (not env) so operator additions via the
// POST /api/system/plugin-trusted-hosts endpoint take effect immediately.

import { hostIsPrivate } from '../../routes/models.validation.js';
import { getPluginTrustedHosts } from '../systemLauncher/liveSettings.js';

const BUILTIN_HOSTS = new Set(['github.com', 'gitlab.com', 'huggingface.co', 'www.github.com', 'www.gitlab.com']);

function allowedHosts(): Set<string> {
  const out = new Set<string>(BUILTIN_HOSTS);
  for (const h of getPluginTrustedHosts()) out.add(h);
  return out;
}

export interface ValidationResult {
  ok: boolean;
  error?: string;
  normalized?: string;
}

export function validatePluginUrl(input: string): ValidationResult {
  if (!input || typeof input !== 'string') return { ok: false, error: 'URL is required' };
  let parsed: URL;
  try { parsed = new URL(input.trim()); }
  catch { return { ok: false, error: 'Invalid URL format' }; }
  if (parsed.protocol !== 'https:') return { ok: false, error: 'Only https:// URLs are allowed' };
  const host = parsed.hostname.toLowerCase();
  if (!allowedHosts().has(host)) return { ok: false, error: `Host not allowed: ${host}` };
  if (hostIsPrivate(parsed.toString())) return { ok: false, error: 'Host resolves to a private/loopback range' };
  return { ok: true, normalized: parsed.toString().replace(/\.git\/?$/, '') };
}

/** Validate for the common subset: a GitHub URL with parseable owner/repo. */
export function parseGithubOwnerRepo(url: string): { owner: string; repo: string } | null {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/, '') };
}

/**
 * Apply a GitHub proxy prefix if the user or the studio has one configured.
 * Matches launcher's proxy rewrite semantics: empty / https://github.com means
 * "no proxy".
 */
export function applyGithubProxy(githubUrl: string, proxy: string): string {
  const trimmed = (proxy || '').trim();
  if (!trimmed) return githubUrl;
  if (trimmed === 'https://github.com' || trimmed === 'https://github.com/') return githubUrl;
  const withSlash = trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
  return githubUrl.replace('https://github.com/', withSlash);
}
