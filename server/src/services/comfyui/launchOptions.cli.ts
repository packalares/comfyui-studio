// CLI-args builder for launch-options. Kept separate from the JSON I/O
// concerns in launchOptions.service.ts so both files stay under the 250-line
// cap.

import { env } from '../../config/env.js';
import {
  getDefaultFrontendVersion,
  FIXED_IN_ENTRYPOINT,
  type LaunchOptionItem,
} from './launchOptions.defaults.js';

export interface LaunchOptionsConfigLike {
  mode: 'list' | 'manual';
  items: LaunchOptionItem[];
  manualArgs?: string;
}

// Strip --port and --front-end-version from manual args (system-fixed).
function filterReadonlyFromManual(tokens: string[]): string[] {
  const strip = new Set(['--port', '--front-end-version']);
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (strip.has(tokens[i])) {
      i++;
      if (i < tokens.length && !tokens[i].startsWith('-')) i++;
      continue;
    }
    out.push(tokens[i]);
    i++;
  }
  return out;
}

export function buildExtraArgsArray(cfg: LaunchOptionsConfigLike): string[] {
  if (cfg.mode === 'manual') {
    const manual = (cfg.manualArgs || '').trim();
    if (!manual) return [];
    return filterReadonlyFromManual(manual.split(/\s+/).filter(Boolean));
  }
  const args: string[] = [];
  for (const item of cfg.items) {
    if (!item.enabled || !item.key) continue;
    if (FIXED_IN_ENTRYPOINT.has(item.key)) continue;
    if (!/^[-a-zA-Z0-9_]+$/.test(item.key)) continue;
    if (item.type === 'flag') { args.push(item.key); continue; }
    const value = item.value === undefined || item.value === null || item.value === ''
      ? null : String(item.value);
    if (item.key === '--front-end-version') {
      args.push(item.key, value || getDefaultFrontendVersion());
      continue;
    }
    if (value !== null) args.push(item.key, value);
  }
  return args;
}

export interface LaunchCommandView {
  mode: 'list' | 'manual';
  items: LaunchOptionItem[];
  manualArgs: string;
  baseCommand: string;
  fixedArgs: string[];
  extraArgs: string[];
  fullCommandLine: string;
}

export function buildLaunchCommandView(cfg: LaunchOptionsConfigLike): LaunchCommandView {
  const extraArgs = buildExtraArgsArray(cfg);
  const baseCommand = 'python3 ./ComfyUI/main.py';
  const fixedArgs = ['--listen', '--port', String(env.COMFYUI_PORT)];
  const fullParts = [baseCommand, ...fixedArgs, ...extraArgs].filter(Boolean);
  return {
    mode: cfg.mode,
    items: cfg.items,
    manualArgs: cfg.manualArgs || '',
    baseCommand,
    fixedArgs,
    extraArgs,
    fullCommandLine: fullParts.join(' ').trim(),
  };
}
