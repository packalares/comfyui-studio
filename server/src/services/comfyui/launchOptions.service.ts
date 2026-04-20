// ComfyUI launch-options service. JSON config read/write via atomicWrite.
// PUT merges partial into full. POST /reset restores defaults + seeds from
// env.CLI_ARGS so orchestrator-defined defaults are not wiped on a fresh
// install.

import fs from 'fs';
import path from 'path';
import { env } from '../../config/env.js';
import { paths } from '../../config/paths.js';
import { atomicWrite } from '../../lib/fs.js';
import { logger } from '../../lib/logger.js';
import {
  buildDefaultItems,
  getDefaultFrontendVersion,
  DEFAULT_CLI_ARGS_FALLBACK,
  type LaunchOptionItem,
} from './launchOptions.defaults.js';
import {
  buildExtraArgsArray,
  buildLaunchCommandView,
  type LaunchCommandView,
} from './launchOptions.cli.js';

export type { LaunchOptionItem, LaunchOptionType } from './launchOptions.defaults.js';
export type { LaunchCommandView } from './launchOptions.cli.js';

export interface LaunchOptionsConfig {
  mode: 'list' | 'manual';
  items: LaunchOptionItem[];
  manualArgs?: string;
}

function configFilePath(): string {
  return path.join(paths.dataDir, 'comfyui-launch-options.json');
}

// Apply a CLI args string onto a base items list. Tokens starting with '-'
// introduce a key; the next token is its value unless it also starts with '-'.
function applyCliArgsToItems(cliArgs: string, baseItems: LaunchOptionItem[]): LaunchOptionItem[] {
  const tokens = cliArgs.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return baseItems;
  const byKey = new Map(baseItems.map((i) => [i.key, { ...i }]));
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (!token.startsWith('-')) { i++; continue; }
    const key = token;
    let value: string | null = null;
    const next = tokens[i + 1];
    if (next && !next.startsWith('-')) { value = next; i += 2; }
    else { i += 1; }
    const item = byKey.get(key);
    if (item) {
      item.enabled = true;
      if (item.type !== 'flag' && value !== null) item.value = value;
    } else {
      byKey.set(key, {
        key, value, enabled: true,
        type: value === null ? 'flag' : 'string',
        description: '', category: 'other', order: 9999,
      });
    }
  }
  return Array.from(byKey.values()).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export function getDefaultConfig(): LaunchOptionsConfig {
  const envCliArgs = (env.CLI_ARGS || DEFAULT_CLI_ARGS_FALLBACK).trim();
  const baseItems = buildDefaultItems();
  const seededItems = envCliArgs ? applyCliArgsToItems(envCliArgs, baseItems) : baseItems;
  return {
    mode: envCliArgs ? 'manual' : 'list',
    items: seededItems,
    manualArgs: envCliArgs,
  };
}

function ensureConfigFile(): void {
  const p = configFilePath();
  try {
    if (!fs.existsSync(p)) {
      atomicWrite(p, JSON.stringify(getDefaultConfig(), null, 2));
    }
  } catch (error) {
    logger.error('launch_options init failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function normalizeItem(
  item: LaunchOptionItem,
  def: LaunchOptionItem | undefined,
  index: number,
): LaunchOptionItem {
  const readOnly = def?.readOnly ?? item.readOnly ?? false;
  let value = item.value ?? def?.value ?? null;
  if (readOnly && item.key === '--port') value = env.COMFYUI_PORT;
  if (readOnly && item.key === '--front-end-version') value = getDefaultFrontendVersion();
  return {
    key: item.key,
    value,
    enabled: typeof item.enabled === 'boolean' ? item.enabled : (def?.enabled ?? false),
    type: (item.type || def?.type || 'string') as LaunchOptionItem['type'],
    description: item.description || def?.description || '',
    category: item.category ?? def?.category,
    order: typeof item.order === 'number' ? item.order : index * 10,
    readOnly,
  };
}

function mergeWithDefaults(rawItems: LaunchOptionItem[]): LaunchOptionItem[] {
  const defaultConfig = getDefaultConfig();
  const defaultByKey = new Map(defaultConfig.items.map((i) => [i.key, i]));
  const rawKeys = new Set(rawItems.map((i) => i.key));
  const merged: LaunchOptionItem[] = rawItems
    .map((item, index) => normalizeItem(item, defaultByKey.get(item.key), index))
    .filter((item) => !!item.key);
  for (const def of defaultConfig.items) {
    if (rawKeys.has(def.key)) continue;
    let value = def.value ?? null;
    if (def.readOnly && def.key === '--port') value = env.COMFYUI_PORT;
    if (def.readOnly && def.key === '--front-end-version') value = getDefaultFrontendVersion();
    merged.push({
      key: def.key, value, enabled: def.enabled, type: def.type,
      description: def.description || '', category: def.category,
      order: def.order ?? 999, readOnly: def.readOnly,
    });
  }
  return merged.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export function readConfig(): LaunchOptionsConfig {
  ensureConfigFile();
  const defaultConfig = getDefaultConfig();
  try {
    const content = fs.readFileSync(configFilePath(), 'utf-8');
    const raw = JSON.parse(content) as Partial<LaunchOptionsConfig>;
    const mode = raw.mode === 'manual' ? 'manual' : 'list';
    const rawItems = Array.isArray(raw.items) ? raw.items : defaultConfig.items;
    const manualArgs = typeof raw.manualArgs === 'string'
      ? raw.manualArgs
      : defaultConfig.manualArgs || '';
    return { mode, items: mergeWithDefaults(rawItems), manualArgs };
  } catch (error) {
    logger.error('launch_options read failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    return defaultConfig;
  }
}

function writeConfig(value: LaunchOptionsConfig): void {
  try {
    atomicWrite(configFilePath(), JSON.stringify(value, null, 2));
  } catch (error) {
    logger.error('launch_options write failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function resetToDefault(): LaunchOptionsConfig {
  writeConfig(getDefaultConfig());
  return readConfig();
}

export function updateLaunchOptions(payload: Partial<LaunchOptionsConfig>): LaunchOptionsConfig {
  const current = readConfig();
  const mode = payload.mode === 'manual' ? 'manual' : 'list';
  const defaultByKey = new Map(getDefaultConfig().items.map((i) => [i.key, i]));
  const items = Array.isArray(payload.items)
    ? payload.items
      .map((item, index) => normalizeItem(item, defaultByKey.get(item.key), index))
      .filter((item) => !!item.key)
    : current.items;
  const manualArgs = typeof payload.manualArgs === 'string'
    ? payload.manualArgs : (current.manualArgs || '');
  const merged: LaunchOptionsConfig = { mode, items, manualArgs };
  writeConfig(merged);
  return merged;
}

export function buildCliArgs(): string[] {
  return buildExtraArgsArray(readConfig());
}

export function buildCliArgsString(): string {
  return buildCliArgs().join(' ');
}

export function getLaunchOptions(): LaunchOptionsConfig {
  return readConfig();
}

export function getLaunchCommandView(): LaunchCommandView {
  return buildLaunchCommandView(readConfig());
}
