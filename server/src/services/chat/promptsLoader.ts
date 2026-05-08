// Load LLM prompts and chat-suggestion data from a single markdown file.
//
// File shape: top-level `## <key>` sections. Section body runs until the
// next `## ` heading. Bodies that consist of `- `-prefixed lines are
// returned as `string[]` by `getList`; everything else is one string.
//
// Lookup order: user overlay (~/.config/comfyui-studio/chat/default_prompts.md)
// → bundled (server/data/chat/default_prompts.md). Both paths resolve through
// `currentConfigRootOverride()` so tests can isolate via STUDIO_CONFIG_ROOT.
//
// Substitution: Mustache-style `{{varName}}` is replaced from the `vars`
// object at call time; unknown vars are left as the literal `{{name}}` so
// missing data is loud.
//
// Validation runs once at boot. Missing required keys are logged loudly but
// the server keeps running with the keys that ARE present.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { paths } from '../../config/paths.js';
import { currentConfigRootOverride } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

// ---- Public types --------------------------------------------------------

export type ToolName = 'web_search' | 'generate_image';

export interface ContextualSuggestions {
  codeFenced: string[];
  question: string[];
  urlBearing: string[];
  fallback: string[];
  longReplyExtra: string;
}

export interface ChatSuggestions {
  emptyState: string[];
  contextual: ContextualSuggestions;
}

// ---- Path resolution -----------------------------------------------------

function getUserPromptsFile(): string {
  const configRoot = currentConfigRootOverride()
    ?? path.join(os.homedir(), '.config', 'comfyui-studio');
  return path.join(configRoot, 'chat', 'default_prompts.md');
}

function getBundledPromptsFile(): string {
  return paths.bundledPromptsFile;
}

// ---- Markdown parsing ----------------------------------------------------

/**
 * Parse `## <key>\n<body>` sections into a Map. Sections are joined back
 * by newline; trailing whitespace per body is trimmed but internal newlines
 * are preserved (multi-line prompts need them).
 */
function parseSections(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  // Split on lines that start with `## ` (note the trailing space — # at
  // column 0 with content after it). The first chunk before any `## ` is
  // the file preamble (comments) and is discarded.
  const lines = raw.split('\n');
  let currentKey: string | null = null;
  let buffer: string[] = [];
  const flush = (): void => {
    if (currentKey === null) return;
    // Trim trailing blank lines but keep leading single space for sections
    // like ` (prompt routed to field "...")` whose leading space is content.
    while (buffer.length > 0 && buffer[buffer.length - 1].trim() === '') buffer.pop();
    out.set(currentKey, buffer.join('\n'));
  };
  for (const line of lines) {
    const m = line.match(/^##\s+(\S.*?)\s*$/);
    if (m) {
      flush();
      currentKey = m[1];
      buffer = [];
      continue;
    }
    if (currentKey === null) continue;     // preamble before first heading
    buffer.push(line);
  }
  flush();
  return out;
}

/** Body has at least one `- ` line and no non-bullet content lines → list. */
function isBulletList(body: string): boolean {
  const lines = body.split('\n').filter(l => l.trim() !== '');
  if (lines.length === 0) return false;
  return lines.every(l => /^\s*-\s+/.test(l));
}

function bulletsToList(body: string): string[] {
  return body.split('\n')
    .map(l => l.replace(/^\s*-\s+/, '').trim())
    .filter(s => s.length > 0);
}

// ---- In-memory cache -----------------------------------------------------

let cache: Map<string, string> | null = null;

function loadRaw(): string {
  const userFile = getUserPromptsFile();
  try {
    return fs.readFileSync(userFile, 'utf8');
  } catch { /* not present, fall through */ }
  try {
    return fs.readFileSync(getBundledPromptsFile(), 'utf8');
  } catch (err) {
    logger.error('promptsLoader: bundled default_prompts.md is missing', {
      path: getBundledPromptsFile(),
      message: err instanceof Error ? err.message : String(err),
    });
    return '';
  }
}

function getCache(): Map<string, string> {
  if (cache !== null) return cache;
  cache = parseSections(loadRaw());
  return cache;
}

/** Drop the cache so the next access re-reads the file. Used in tests. */
export function _resetPromptsCache(): void {
  cache = null;
}

// ---- Public API ----------------------------------------------------------

/** Get a section body verbatim. Logs a warning and returns '' if missing. */
export function get(key: string): string {
  const v = getCache().get(key);
  if (v === undefined) {
    logger.warn('promptsLoader: missing key', { key });
    return '';
  }
  return v;
}

/** Get a bullet-list section as string[]. Returns [] if missing or non-list. */
export function getList(key: string): string[] {
  const v = getCache().get(key);
  if (v === undefined) {
    logger.warn('promptsLoader: missing key', { key });
    return [];
  }
  if (!isBulletList(v)) return [];
  return bulletsToList(v);
}

/**
 * Substitute Mustache-style {{varName}} placeholders in a section body.
 * Unknown placeholders pass through unchanged so missing vars are visible.
 */
export function template(key: string, vars: Record<string, string>): string {
  const body = get(key);
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, name: string) => {
    const v = vars[name];
    return typeof v === 'string' ? v : whole;
  });
}

/** Build the chat-suggestions envelope sent to the UI via /api/system. */
export function getSuggestions(): ChatSuggestions {
  return {
    emptyState: getList('suggestions.empty-state'),
    contextual: {
      codeFenced: getList('suggestions.contextual.code-fenced'),
      question: getList('suggestions.contextual.question'),
      urlBearing: getList('suggestions.contextual.url-bearing'),
      fallback: getList('suggestions.contextual.fallback'),
      longReplyExtra: get('suggestions.contextual.long-reply-extra'),
    },
  };
}

const TOOL_NAMES: readonly ToolName[] = ['web_search', 'generate_image'] as const;

function toolKey(name: ToolName): string {
  return name.replace(/_/g, '-');
}

/** UI-facing tool labels keyed by chat tool name. Frozen, evaluated at call time. */
export function getToolLabels(): Record<ToolName, string> {
  const out = {} as Record<ToolName, string>;
  for (const n of TOOL_NAMES) out[n] = get(`tool-label.${toolKey(n)}`);
  return Object.freeze(out);
}

/** UI-facing tool descriptions keyed by chat tool name. */
export function getToolLabelDescriptions(): Record<ToolName, string> {
  const out = {} as Record<ToolName, string>;
  for (const n of TOOL_NAMES) out[n] = get(`tool-label-description.${toolKey(n)}`);
  return Object.freeze(out);
}

// ---- Boot-time validation -----------------------------------------------

const REQUIRED_KEYS: readonly string[] = [
  'title',
  'compact-summary-prefix',
  'compact-summary-wrap',
  'tool-description.web-search',
  'tool-description.rag-search',
  'tool-description.rag-upload',
  'tool-description.generate-image',
  'tool-label.web-search',
  'tool-label.rag-search',
  'tool-label.rag-upload',
  'tool-label.generate-image',
  'tool-label-description.web-search',
  'tool-label-description.rag-search',
  'tool-label-description.rag-upload',
  'tool-label-description.generate-image',
  'generate-image.queued-result',
  'generate-image.prompt-field-note',
  'generate-image.no-field-note',
  'generate-image.failed-prefix',
  'generate-image.no-template-error',
  'rag-search.no-kb-error',
  'tool-error-reprompt',
  'suggestions.empty-state',
  'suggestions.contextual.code-fenced',
  'suggestions.contextual.question',
  'suggestions.contextual.url-bearing',
  'suggestions.contextual.fallback',
  'suggestions.contextual.long-reply-extra',
] as const;

/** Verify every required key resolves; log a single error listing any gaps. */
export function validatePromptsFile(): void {
  const c = getCache();
  const missing = REQUIRED_KEYS.filter(k => !c.has(k));
  if (missing.length > 0) {
    logger.error('promptsLoader: required keys missing from default_prompts.md', { missing });
  }
}
