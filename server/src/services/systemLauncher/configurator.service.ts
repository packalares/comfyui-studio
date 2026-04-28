// Persistent environment configurator. No process-env mutation: live values
// live in `liveSettings.ts` (single source of truth) and this module handles
// URL validation + atomic persistence to disk.
//
// Persistence format is `env-config.json` — kept compatible with prior
// launcher installs so their saved choices are picked up on first boot.

import fs from 'fs';
import { paths } from '../../config/paths.js';
import { atomicWrite } from '../../lib/fs.js';
import { logger } from '../../lib/logger.js';
import * as liveSettings from './liveSettings.js';
import type { LiveSettings } from './liveSettings.js';

export interface EnvConfigFile {
  HF_ENDPOINT?: string;
  GITHUB_PROXY?: string;
  PIP_INDEX_URL?: string;
  PLUGIN_TRUSTED_HOSTS?: string[];
  MODEL_TRUSTED_HOSTS?: string[];
  PIP_ALLOW_PRIVATE_IP?: boolean;
}

export interface ConfigureResult {
  success: boolean;
  message: string;
  data?: { url: string } | null;
}

const FILE = paths.envConfigFile;

// ---- URL validation ----

/**
 * HTTPS-only URL gate. Private/loopback hosts are allowed here because some
 * deployments point pip at a local cache (e.g. `https://127.0.0.1/pypi/`).
 * Operator-initiated — the route is already rate-limited to blunt abuse.
 */
export function validateUrl(url: string): { ok: boolean; error?: string } {
  if (typeof url !== 'string' || url.length === 0) {
    return { ok: false, error: 'URL is required' };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: 'Invalid URL' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, error: 'URL must use http or https' };
  }
  if (parsed.protocol === 'http:' && !isLoopback(parsed.hostname)) {
    return { ok: false, error: 'http URLs allowed only for loopback' };
  }
  return { ok: true };
}

/**
 * Pip-source-only validator. Same as validateUrl but if liveSettings has
 * `allowPrivateIpMirrors: true` we ALSO accept `http://` on RFC1918 /
 * link-local / IPv6 unique-local ranges. Chosen separately from the
 * general configurator validator so HF endpoint + GitHub proxy stay tight.
 */
export function validatePipSource(url: string): { ok: boolean; error?: string } {
  const v = validateUrl(url);
  if (v.ok) return v;
  if (!liveSettings.getAllowPrivateIpMirrors()) return v;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return v; }
  if (parsed.protocol !== 'http:') return v;
  return isPrivateHost(parsed.hostname) ? { ok: true } : v;
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function isPrivateHost(host: string): boolean {
  if (isLoopback(host)) return true;
  // RFC1918 IPv4
  if (/^10\.\d+\.\d+\.\d+$/.test(host)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host)) return true;
  // Link-local
  if (/^169\.254\.\d+\.\d+$/.test(host)) return true;
  // IPv6 unique-local fc00::/7, link-local fe80::/10
  const h = host.toLowerCase();
  if (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80:')) return true;
  return false;
}

// ---- Disk I/O ----

function readFile(): EnvConfigFile {
  try {
    if (!fs.existsSync(FILE)) return {};
    const raw = fs.readFileSync(FILE, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as EnvConfigFile;
  } catch (err) {
    logger.warn('configurator: load failed', { error: String(err) });
    return {};
  }
}

function writeFile(snapshot: LiveSettings): void {
  const payload: EnvConfigFile = {};
  if (snapshot.hfEndpoint) payload.HF_ENDPOINT = snapshot.hfEndpoint;
  if (snapshot.githubProxy) payload.GITHUB_PROXY = snapshot.githubProxy;
  if (snapshot.pipSource) payload.PIP_INDEX_URL = snapshot.pipSource;
  if (snapshot.pluginTrustedHosts.length > 0) payload.PLUGIN_TRUSTED_HOSTS = snapshot.pluginTrustedHosts;
  if (snapshot.modelTrustedHosts.length > 0) payload.MODEL_TRUSTED_HOSTS = snapshot.modelTrustedHosts;
  if (snapshot.allowPrivateIpMirrors) payload.PIP_ALLOW_PRIVATE_IP = true;
  atomicWrite(FILE, JSON.stringify(payload, null, 2));
  logger.info('configurator: env-config persisted', { path: FILE });
}

// Bind the write-through callback so liveSettings.setX() flushes to disk.
liveSettings.bindPersist(writeFile);

/**
 * Load persisted settings from disk into `liveSettings`. Call once at
 * server boot. Env-provided values win only when the file is absent.
 */
export function loadPersisted(): void {
  const saved = readFile();
  liveSettings.hydrate({
    hfEndpoint: saved.HF_ENDPOINT,
    githubProxy: saved.GITHUB_PROXY,
    pipSource: saved.PIP_INDEX_URL,
    pluginTrustedHosts: Array.isArray(saved.PLUGIN_TRUSTED_HOSTS) ? saved.PLUGIN_TRUSTED_HOSTS : undefined,
    modelTrustedHosts: Array.isArray(saved.MODEL_TRUSTED_HOSTS) ? saved.MODEL_TRUSTED_HOSTS : undefined,
    allowPrivateIpMirrors: typeof saved.PIP_ALLOW_PRIVATE_IP === 'boolean' ? saved.PIP_ALLOW_PRIVATE_IP : undefined,
  });
}

// ---- Setters (wired to routes) ----

export function setPipSource(url: string): ConfigureResult {
  const v = validatePipSource(url);
  if (!v.ok) return { success: false, message: v.error ?? 'Invalid URL', data: null };
  liveSettings.setPipSource(url);
  return { success: true, message: 'pip source updated', data: { url } };
}

export function setHuggingFaceEndpoint(url: string): ConfigureResult {
  const v = validateUrl(url);
  if (!v.ok) return { success: false, message: v.error ?? 'Invalid URL', data: null };
  liveSettings.setHfEndpoint(url);
  return { success: true, message: 'HuggingFace endpoint updated', data: { url } };
}

export function setGithubProxy(url: string): ConfigureResult {
  const v = validateUrl(url);
  if (!v.ok) return { success: false, message: v.error ?? 'Invalid URL', data: null };
  liveSettings.setGithubProxy(url);
  return { success: true, message: 'GitHub proxy updated', data: { url } };
}

export function setPluginTrustedHosts(hosts: string[]): ConfigureResult {
  const v = validateHostList(hosts);
  if (!v.ok) return { success: false, message: v.error ?? 'invalid hosts', data: null };
  liveSettings.setPluginTrustedHosts(hosts);
  return { success: true, message: 'plugin trusted hosts updated', data: null };
}

export function setModelTrustedHosts(hosts: string[]): ConfigureResult {
  const v = validateHostList(hosts);
  if (!v.ok) return { success: false, message: v.error ?? 'invalid hosts', data: null };
  liveSettings.setModelTrustedHosts(hosts);
  return { success: true, message: 'model trusted hosts updated', data: null };
}

function validateHostList(hosts: unknown): { ok: boolean; error?: string } {
  if (!Array.isArray(hosts)) return { ok: false, error: 'hosts must be an array' };
  for (const h of hosts) {
    if (typeof h !== 'string' || !/^[a-zA-Z0-9.\-:]+$/.test(h)) {
      return { ok: false, error: `invalid host: ${String(h)}` };
    }
  }
  return { ok: true };
}

export function setAllowPrivateIpMirrors(allow: boolean): ConfigureResult {
  liveSettings.setAllowPrivateIpMirrors(!!allow);
  return { success: true, message: 'private-IP mirror policy updated', data: null };
}
