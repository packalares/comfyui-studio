// In-memory live-settings registry for the three launcher-configurable URLs:
//   - HF_ENDPOINT         (HuggingFace mirror base)
//   - GITHUB_PROXY        (GitHub clone/download proxy prefix)
//   - PIP_INDEX_URL       (alternate pip index)
//
// Why memory-backed instead of reading env directly at every call site?
//
// The launcher lets the operator change these three URLs over HTTP
// (POST /api/system/huggingface-endpoint, etc.). If consumers read
// `env.HF_ENDPOINT` at call time they would only pick up the change after a
// process restart — defeating the feature. This module holds the current
// value in memory, seeded from `env.*` at boot, and the configurator calls
// `setX()` below to update it.
//
// The configurator is injected lazily (see `bindPersist`) so this file has
// no circular import with `configurator.service.ts`.
//
// ABSOLUTE RULE: this is the single authoritative reader of
// `env.HF_ENDPOINT` / `env.GITHUB_PROXY` / `env.PIP_INDEX_URL` outside
// `config/env.ts`. All other services MUST call the getters below.

import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

type Persist = (snapshot: LiveSettings) => void;

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

/**
 * Inject a persistence callback (called by `configurator.service.ts` at
 * module load). Split like this to avoid a circular import: configurator
 * depends on this file for the live getters, and this file needs the
 * configurator's `persist()` only to write through on mutation.
 */
export function bindPersist(fn: Persist): void {
  persistFn = fn;
}

/**
 * Overwrite in-memory state from a persisted snapshot (used at startup
 * after the configurator loads its JSON file). Does NOT invoke the persist
 * callback — the disk is already authoritative here.
 */
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

// ---- Getters (consumed across services) ----

export function getHfEndpoint(): string {
  return state.hfEndpoint;
}

export function getGithubProxy(): string {
  return state.githubProxy;
}

export function getPipSource(): string {
  return state.pipSource;
}

export function getPluginTrustedHosts(): string[] {
  return [...state.pluginTrustedHosts];
}

export function getModelTrustedHosts(): string[] {
  return [...state.modelTrustedHosts];
}

export function getAllowPrivateIpMirrors(): boolean {
  return state.allowPrivateIpMirrors;
}

/** Full snapshot used by the system.service for the `/network-config` view. */
export function snapshot(): LiveSettings {
  return { ...state };
}

// ---- Setters (only invoked by configurator.service.ts) ----

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
