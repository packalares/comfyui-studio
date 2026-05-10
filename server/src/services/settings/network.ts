// Network-URL settings: in-memory live state + atomic persistence to
// env-config.json + URL validation + the /api/system `network` projection.
//
// Kept separate from the main config.json store for back-compat: prior
// launcher installs already have env-config.json on disk; migrating that
// data into config.json is out of scope.
//
// ABSOLUTE RULE: this is the single authoritative reader of
// env.HF_ENDPOINT / env.GITHUB_PROXY / env.PIP_INDEX_URL outside
// config/env.ts. All other services MUST call the getters below.

import fs from 'fs';
import { env } from '../../config/env.js';
import { paths } from '../../config/paths.js';
import { atomicWrite } from '../../lib/fs.js';
import { logger } from '../../lib/logger.js';

// ---- Types ----

export interface LiveSettings {
  hfEndpoint: string;
  githubProxy: string;
  pipSource: string;
  /** Extra hosts allowed for plugin install URLs (in addition to the built-in trio). */
  pluginTrustedHosts: string[];
  /** Extra hosts allowed for model-download URLs (in addition to the built-in set). */
  modelTrustedHosts: string[];
  /** When true, the pip-source validator accepts `http://` URLs on private IPs. */
  allowPrivateIpMirrors: boolean;
}

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

export interface NetworkConfigView {
  /** Flat keys the frontend NetworkCard reads directly. */
  huggingfaceEndpoint: string;
  githubProxy: string;
  pipSource: string;
  /** Extra hosts accepted by the plugin-install URL validator. */
  pluginTrustedHosts: string[];
  /** Extra hosts accepted by the model-download URL validator. */
  modelTrustedHosts: string[];
  /** When true, pip-source accepts http:// on private IPs. */
  allowPrivateIpMirrors: boolean;
  /** Last-known reachability for each service (unknown until the first check runs). */
  reachability: {
    github: { url: string; accessible: boolean; latencyMs?: number };
    pip: { url: string; accessible: boolean; latencyMs?: number };
    huggingface: { url: string; accessible: boolean; latencyMs?: number };
  };
}

// ---- In-memory state ----

type Persist = (snapshot: LiveSettings) => void;

function parseHostList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(s => s.length > 0 && /^[a-z0-9.\-:]+$/.test(s));
}

// Seed from env so pod-level overrides still take effect on first boot.
const state: LiveSettings = {
  hfEndpoint: env.HF_ENDPOINT,
  githubProxy: env.GITHUB_PROXY,
  pipSource: env.PIP_INDEX_URL,
  pluginTrustedHosts: parseHostList(env.PLUGIN_TRUSTED_HOSTS),
  modelTrustedHosts: parseHostList(env.MODEL_TRUSTED_HOSTS),
  allowPrivateIpMirrors: env.PIP_ALLOW_PRIVATE_IP === true,
};

let persistFn: Persist | null = null;

// Split to avoid circular import: configurator depends on this file for
// the live getters; this file needs configurator's persist only on mutation.
export function bindPersist(fn: Persist): void {
  persistFn = fn;
}

// Does NOT invoke the persist callback — disk is already authoritative here.
export function hydrate(snapshot: Partial<LiveSettings>): void {
  if (typeof snapshot.hfEndpoint === 'string') state.hfEndpoint = snapshot.hfEndpoint;
  if (typeof snapshot.githubProxy === 'string') state.githubProxy = snapshot.githubProxy;
  if (typeof snapshot.pipSource === 'string') state.pipSource = snapshot.pipSource;
  if (Array.isArray(snapshot.pluginTrustedHosts)) {
    state.pluginTrustedHosts = snapshot.pluginTrustedHosts
      .filter((h): h is string => typeof h === 'string')
      .map(h => h.trim().toLowerCase())
      .filter(h => h.length > 0);
  }
  if (Array.isArray(snapshot.modelTrustedHosts)) {
    state.modelTrustedHosts = snapshot.modelTrustedHosts
      .filter((h): h is string => typeof h === 'string')
      .map(h => h.trim().toLowerCase())
      .filter(h => h.length > 0);
  }
  if (typeof snapshot.allowPrivateIpMirrors === 'boolean') {
    state.allowPrivateIpMirrors = snapshot.allowPrivateIpMirrors;
  }
}

// ---- Getters ----

export function getHfEndpoint(): string { return state.hfEndpoint; }
export function getGithubProxy(): string { return state.githubProxy; }
export function getPipSource(): string { return state.pipSource; }
export function getPluginTrustedHosts(): string[] { return [...state.pluginTrustedHosts]; }
export function getModelTrustedHosts(): string[] { return [...state.modelTrustedHosts]; }
export function getAllowPrivateIpMirrors(): boolean { return state.allowPrivateIpMirrors; }

/** Full snapshot used for the `/network-config` view. */
export function snapshot(): LiveSettings { return { ...state }; }

// ---- Setters (only invoked by configurator logic below) ----

function writeThrough(): void {
  if (!persistFn) {
    logger.warn('liveSettings: persist not bound yet; skipping disk flush');
    return;
  }
  try {
    persistFn(snapshot());
  } catch (err) {
    logger.warn('liveSettings: persist failed', { error: String(err) });
  }
}

export function setHfEndpoint(url: string): void {
  state.hfEndpoint = url;
  writeThrough();
}

export function setGithubProxy(url: string): void {
  state.githubProxy = url;
  writeThrough();
}

export function setPipSource(url: string): void {
  state.pipSource = url;
  writeThrough();
}

export function setPluginTrustedHosts(hosts: string[]): void {
  state.pluginTrustedHosts = cleanHostList(hosts);
  writeThrough();
}

export function setModelTrustedHosts(hosts: string[]): void {
  state.modelTrustedHosts = cleanHostList(hosts);
  writeThrough();
}

function cleanHostList(hosts: string[]): string[] {
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const raw of hosts) {
    if (typeof raw !== 'string') continue;
    const h = raw.trim().toLowerCase();
    if (!h || !/^[a-z0-9.\-:]+$/.test(h) || seen.has(h)) continue;
    seen.add(h);
    cleaned.push(h);
  }
  return cleaned;
}

export function setAllowPrivateIpMirrors(allow: boolean): void {
  state.allowPrivateIpMirrors = !!allow;
  writeThrough();
}

// ---- Disk I/O (env-config.json) ----

const FILE = paths.envConfigFile;

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

function writeFile(snap: LiveSettings): void {
  const payload: EnvConfigFile = {};
  if (snap.hfEndpoint) payload.HF_ENDPOINT = snap.hfEndpoint;
  if (snap.githubProxy) payload.GITHUB_PROXY = snap.githubProxy;
  if (snap.pipSource) payload.PIP_INDEX_URL = snap.pipSource;
  if (snap.pluginTrustedHosts.length > 0) payload.PLUGIN_TRUSTED_HOSTS = snap.pluginTrustedHosts;
  if (snap.modelTrustedHosts.length > 0) payload.MODEL_TRUSTED_HOSTS = snap.modelTrustedHosts;
  if (snap.allowPrivateIpMirrors) payload.PIP_ALLOW_PRIVATE_IP = true;
  atomicWrite(FILE, JSON.stringify(payload, null, 2));
  logger.info('configurator: env-config persisted', { path: FILE });
}

// Bind the write-through callback so setX() flushes to disk.
bindPersist(writeFile);

/** Load persisted settings from env-config.json. Call once at server boot. */
export function loadPersisted(): void {
  const saved = readFile();
  hydrate({
    hfEndpoint: saved.HF_ENDPOINT,
    githubProxy: saved.GITHUB_PROXY,
    pipSource: saved.PIP_INDEX_URL,
    pluginTrustedHosts: Array.isArray(saved.PLUGIN_TRUSTED_HOSTS) ? saved.PLUGIN_TRUSTED_HOSTS : undefined,
    modelTrustedHosts: Array.isArray(saved.MODEL_TRUSTED_HOSTS) ? saved.MODEL_TRUSTED_HOSTS : undefined,
    allowPrivateIpMirrors: typeof saved.PIP_ALLOW_PRIVATE_IP === 'boolean' ? saved.PIP_ALLOW_PRIVATE_IP : undefined,
  });
}

// ---- URL validation ----

// HTTPS-only gate; private/loopback allowed because some deployments point
// pip at a local cache (e.g. https://127.0.0.1/pypi/). Operator-initiated —
// route is already rate-limited to blunt abuse.
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

// Same as validateUrl, but when allowPrivateIpMirrors is true also accepts
// http:// on RFC1918 / link-local / IPv6 ULA. HF endpoint + GitHub proxy
// intentionally use validateUrl (tighter) — only pip gets this relaxed path.
export function validatePipSource(url: string): { ok: boolean; error?: string } {
  const v = validateUrl(url);
  if (v.ok) return v;
  if (!getAllowPrivateIpMirrors()) return v;
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
  if (/^10\.\d+\.\d+\.\d+$/.test(host)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host)) return true;
  if (/^169\.254\.\d+\.\d+$/.test(host)) return true;
  // IPv6 ULA fc00::/7, link-local fe80::/10
  const h = host.toLowerCase();
  if (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80:')) return true;
  return false;
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

// ---- Configurator setters (wired to routes) ----

export function setPipSourceConfig(url: string): ConfigureResult {
  const v = validatePipSource(url);
  if (!v.ok) return { success: false, message: v.error ?? 'Invalid URL', data: null };
  setPipSource(url);
  return { success: true, message: 'pip source updated', data: { url } };
}

export function setHuggingFaceEndpoint(url: string): ConfigureResult {
  const v = validateUrl(url);
  if (!v.ok) return { success: false, message: v.error ?? 'Invalid URL', data: null };
  setHfEndpoint(url);
  return { success: true, message: 'HuggingFace endpoint updated', data: { url } };
}

export function setGithubProxyConfig(url: string): ConfigureResult {
  const v = validateUrl(url);
  if (!v.ok) return { success: false, message: v.error ?? 'Invalid URL', data: null };
  setGithubProxy(url);
  return { success: true, message: 'GitHub proxy updated', data: { url } };
}

export function setPluginTrustedHostsConfig(hosts: string[]): ConfigureResult {
  const v = validateHostList(hosts);
  if (!v.ok) return { success: false, message: v.error ?? 'invalid hosts', data: null };
  setPluginTrustedHosts(hosts);
  return { success: true, message: 'plugin trusted hosts updated', data: null };
}

export function setModelTrustedHostsConfig(hosts: string[]): ConfigureResult {
  const v = validateHostList(hosts);
  if (!v.ok) return { success: false, message: v.error ?? 'invalid hosts', data: null };
  setModelTrustedHosts(hosts);
  return { success: true, message: 'model trusted hosts updated', data: null };
}

export function setAllowPrivateIpMirrorsConfig(allow: boolean): ConfigureResult {
  setAllowPrivateIpMirrors(!!allow);
  return { success: true, message: 'private-IP mirror policy updated', data: null };
}

// ---- System facade (getNetworkConfig) ----

type ReachabilityStatus = Record<string, { accessible: boolean; latencyMs?: number }>;

// `network` field on `/api/system`. Flat at the top level so the current
// frontend NetworkCard reads those keys directly; `reachability` is additive.
export function getNetworkConfig(lastStatus: ReachabilityStatus | null): NetworkConfigView {
  const snap = snapshot();
  return {
    huggingfaceEndpoint: snap.hfEndpoint || 'https://huggingface.co/',
    githubProxy: snap.githubProxy || 'https://github.com/',
    pipSource: snap.pipSource || 'https://pypi.org/simple/',
    pluginTrustedHosts: snap.pluginTrustedHosts,
    modelTrustedHosts: snap.modelTrustedHosts,
    allowPrivateIpMirrors: snap.allowPrivateIpMirrors,
    reachability: {
      github: {
        url: snap.githubProxy || 'https://github.com/',
        accessible: lastStatus?.github?.accessible ?? false,
        latencyMs: lastStatus?.github?.latencyMs,
      },
      pip: {
        url: snap.pipSource || 'https://pypi.org/simple/',
        accessible: lastStatus?.pip?.accessible ?? false,
        latencyMs: lastStatus?.pip?.latencyMs,
      },
      huggingface: {
        url: snap.hfEndpoint || 'https://huggingface.co/',
        accessible: lastStatus?.huggingface?.accessible ?? false,
        latencyMs: lastStatus?.huggingface?.latencyMs,
      },
    },
  };
}
