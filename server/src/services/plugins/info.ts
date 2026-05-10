// On-disk plugin scanner: reads installed plugin directories and returns
// merged metadata. Sources: pyproject.toml → setup.py → Git remote → fs stats.

import fs from 'fs';
import path from 'path';
import { safeResolve } from '../../lib/fs.js';
import { logger } from '../../lib/logger.js';
import {
  ensurePluginDirs,
  getDisabledPluginsRoot,
  getPluginsRoot,
} from './locations.js';
import type { PluginMetadata } from './types.js';

export type { PluginMetadata } from './types.js';

// ---- TOML reader ----
// Handles the subset needed by pyproject.toml / `[tool.comfy]`: sectioned
// key=value pairs, inline arrays, inline tables. NOT a full TOML parser.

function stripComment(line: string): string {
  let inStr: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inStr) { if (c === inStr && line[i - 1] !== '\\') inStr = null; continue; }
    if (c === '"' || c === '\'') { inStr = c; continue; }
    if (c === '#') return line.slice(0, i);
  }
  return line;
}

function parseValue(raw: string): unknown {
  const s = raw.trim();
  if (s.length === 0) return '';
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith('\'') && s.endsWith('\''))) {
    return s.slice(1, -1);
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^[-+]?\d+(?:\.\d+)?$/.test(s)) return Number(s);
  if (s.startsWith('[') && s.endsWith(']')) return parseArray(s);
  if (s.startsWith('{') && s.endsWith('}')) return parseInlineTable(s);
  return s;
}

function splitTopLevel(input: string, separator: string): string[] {
  const out: string[] = [];
  let bracket = 0;
  let brace = 0;
  let current = '';
  let inStr: string | null = null;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (inStr) { current += c; if (c === inStr && input[i - 1] !== '\\') inStr = null; continue; }
    if (c === '"' || c === '\'') { inStr = c; current += c; continue; }
    if (c === '[') bracket++;
    else if (c === ']') bracket--;
    else if (c === '{') brace++;
    else if (c === '}') brace--;
    if (bracket === 0 && brace === 0 && c === separator) { out.push(current); current = ''; continue; }
    current += c;
  }
  if (current.trim().length > 0) out.push(current);
  return out;
}

function parseArray(raw: string): unknown[] {
  const inner = raw.slice(1, -1).trim();
  if (inner.length === 0) return [];
  return splitTopLevel(inner, ',').map((p) => parseValue(p));
}

function parseInlineTable(raw: string): Record<string, unknown> {
  const inner = raw.slice(1, -1).trim();
  if (inner.length === 0) return {};
  const out: Record<string, unknown> = {};
  for (const pair of splitTopLevel(inner, ',')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const key = pair.slice(0, eq).trim().replace(/^"|"$/g, '').replace(/^'|'$/g, '');
    out[key] = parseValue(pair.slice(eq + 1));
  }
  return out;
}

function resolvePath(root: Record<string, unknown>, name: string): Record<string, unknown> {
  const parts = name.split('.').map((p) => p.trim());
  let node = root;
  for (const part of parts) {
    if (!node[part] || typeof node[part] !== 'object') node[part] = {};
    node = node[part] as Record<string, unknown>;
  }
  return node;
}

/** Fold multiline arrays / inline tables onto their first line. */
function collapseArrays(raw: string): string {
  const out: string[] = [];
  let buffer = '';
  let depth = 0;
  for (const line of raw.split('\n')) {
    const open = (line.match(/[[{]/g) || []).length;
    const close = (line.match(/[\]}]/g) || []).length;
    depth += open - close;
    buffer += (buffer ? ' ' : '') + line;
    if (depth <= 0) {
      out.push(buffer);
      buffer = '';
      depth = 0;
    }
  }
  if (buffer) out.push(buffer);
  return out.join('\n');
}

export function parseMinimalToml(input: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let current = root;
  const raw = input.replace(/\r\n/g, '\n');
  const buffer = collapseArrays(raw);
  for (const rawLine of buffer.split('\n')) {
    const line = stripComment(rawLine).trim();
    if (line.length === 0) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      current = resolvePath(root, line.slice(1, -1).trim());
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().replace(/^"|"$/g, '');
    current[key] = parseValue(line.slice(eq + 1));
  }
  return root;
}

// ---- Metadata parsers ----

function readGitInfo(pluginPath: string): { repoUrl: string } | null {
  try {
    const configPath = path.join(pluginPath, '.git', 'config');
    if (!fs.existsSync(configPath)) return null;
    const content = fs.readFileSync(configPath, 'utf-8');
    const match = content.match(/url\s*=\s*(.+)/i);
    return match ? { repoUrl: match[1].trim() } : null;
  } catch { return null; }
}

function findPyproject(root: string, maxDepth = 2): string | null {
  try {
    const candidate = path.join(root, 'pyproject.toml');
    if (fs.existsSync(candidate)) return candidate;
    if (maxDepth <= 0) return null;
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.')) {
        const sub = path.join(root, e.name);
        const r = findPyproject(sub, maxDepth - 1);
        if (r) return r;
      }
    }
  } catch { /* ignore */ }
  return null;
}

function applyAuthor(project: Record<string, unknown>, m: Partial<PluginMetadata>): void {
  if (Array.isArray(project.authors) && project.authors.length > 0) {
    const first = project.authors[0] as unknown;
    if (typeof first === 'string') m.author = first;
    else if (typeof first === 'object' && first !== null) {
      const fo = first as { name?: string; email?: string };
      m.author = fo.name || fo.email;
    }
  } else if (typeof project.author === 'string') m.author = project.author;
}

function applyLicense(project: Record<string, unknown>, m: Partial<PluginMetadata>): void {
  if (typeof project.license === 'string') { m.license = project.license; return; }
  if (typeof project.license === 'object' && project.license !== null) {
    const lic = project.license as { file?: string };
    if (typeof lic.file === 'string') m.license = lic.file;
  }
}

function extractMetadata(parsed: Record<string, unknown>): Partial<PluginMetadata> {
  const m: Partial<PluginMetadata> = {};
  const project = parsed.project as Record<string, unknown> | undefined;
  if (project) {
    if (typeof project.name === 'string') m.name = project.name;
    if (typeof project.version === 'string') m.version = project.version;
    if (typeof project.description === 'string') m.description = project.description;
    applyAuthor(project, m);
    if (Array.isArray(project.dependencies)) {
      m.dependencies = (project.dependencies as unknown[]).filter((d) => typeof d === 'string') as string[];
    }
    applyLicense(project, m);
  }
  const tool = parsed.tool as Record<string, unknown> | undefined;
  const toolComfy = tool?.comfy as Record<string, unknown> | undefined;
  if (toolComfy && typeof toolComfy.DisplayName === 'string') m.name = toolComfy.DisplayName;
  return m;
}

function getPyprojectMetadata(pluginPath: string): Partial<PluginMetadata> {
  try {
    const p = findPyproject(pluginPath);
    if (!p) return {};
    const raw = fs.readFileSync(p, 'utf-8');
    const parsed = parseMinimalToml(raw);
    return extractMetadata(parsed);
  } catch (err) {
    logger.warn('plugin pyproject parse failed', { message: err instanceof Error ? err.message : String(err) });
    return {};
  }
}

function getSetupPyMetadata(pluginPath: string): Partial<PluginMetadata> {
  try {
    const p = path.join(pluginPath, 'setup.py');
    if (!fs.existsSync(p)) return {};
    const body = fs.readFileSync(p, 'utf-8');
    const m: Partial<PluginMetadata> = {};
    const name = body.match(/name\s*=\s*["']([^"']+)["']/);
    if (name) m.name = name[1];
    const version = body.match(/version\s*=\s*["']([^"']+)["']/);
    if (version) m.version = version[1];
    const desc = body.match(/description\s*=\s*["']([^"']+)["']/);
    if (desc) m.description = desc[1];
    const author = body.match(/author\s*=\s*["']([^"']+)["']/);
    if (author) m.author = author[1];
    return m;
  } catch { return {}; }
}

interface PluginFileStructure {
  hasInstallScript: boolean;
  hasRequirementsFile: boolean;
  requirements: string[];
}

function getPluginFileStructure(pluginPath: string): PluginFileStructure {
  try {
    const files = fs.readdirSync(pluginPath);
    const hasInstallScript = files.some((f) => f === 'install.py' || f === 'setup.py' || f === 'install.sh');
    const hasRequirementsFile = files.some((f) => f === 'requirements.txt' || f === 'requirements-dev.txt');
    let requirements: string[] = [];
    if (hasRequirementsFile) {
      try {
        const req = safeResolve(pluginPath, 'requirements.txt');
        if (fs.existsSync(req)) {
          requirements = fs.readFileSync(req, 'utf-8').split('\n')
            .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
            .map((l) => l.split('==')[0].split('>=')[0].split('<=')[0].split('~=')[0]);
        }
      } catch { /* ignore */ }
    }
    return { hasInstallScript, hasRequirementsFile, requirements };
  } catch { return { hasInstallScript: false, hasRequirementsFile: false, requirements: [] }; }
}

// ---- On-disk scanner ----

function safeStat(p: string): { size: number; lastModified: string; installedOn: string } {
  const fallback = new Date().toISOString();
  try {
    const s = fs.statSync(p);
    return {
      size: s.size,
      lastModified: s.mtime.toISOString(),
      installedOn: s.birthtime?.toISOString?.() || fallback,
    };
  } catch { return { size: 0, lastModified: fallback, installedOn: fallback }; }
}

function mergeMetadata(pluginPath: string): Partial<PluginMetadata> {
  const py = getPyprojectMetadata(pluginPath);
  if (Object.keys(py).length > 0) return py;
  return getSetupPyMetadata(pluginPath);
}

/** Read a single plugin's metadata. Returns null when the dir does not exist. */
export function readPluginInfo(dir: string, isDisabled: boolean): PluginMetadata | null {
  try {
    const root = isDisabled ? getDisabledPluginsRoot() : getPluginsRoot();
    if (!root) return null;
    const pluginPath = safeResolve(root, dir);
    if (!fs.existsSync(pluginPath)) return null;
    const git = readGitInfo(pluginPath);
    const meta = mergeMetadata(pluginPath);
    const structure = getPluginFileStructure(pluginPath);
    const stats = safeStat(pluginPath);
    return {
      id: dir,
      name: meta.name || dir,
      description: meta.description || '',
      author: meta.author || '',
      repository: git?.repoUrl || '',
      version: meta.version || 'nv-1',
      status: 'NodeStatusActive',
      rating: 0,
      downloads: 0,
      github_stars: 0,
      license: meta.license || '{}',
      tags: [],
      dependencies: meta.dependencies || [],
      requirements: structure.requirements,
      supported_accelerators: null,
      supported_os: null,
      created_at: stats.installedOn,
      lastModified: stats.lastModified,
      installed: true,
      installedOn: stats.installedOn,
      disabled: isDisabled,
      hasInstallScript: structure.hasInstallScript,
      hasRequirementsFile: structure.hasRequirementsFile,
      size: stats.size,
    };
  } catch (err) {
    logger.warn('plugin info read failed', { message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

function readDirs(root: string): string[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !/_backup_\d+$/.test(d.name))
      .map((d) => d.name);
  } catch { return []; }
}

/** Walk enabled + disabled plugin dirs, returning metadata per plugin. */
export function getAllInstalledPlugins(): PluginMetadata[] {
  const out: PluginMetadata[] = [];
  const root = getPluginsRoot();
  if (!root) return out;
  ensurePluginDirs();
  for (const name of readDirs(root)) {
    const info = readPluginInfo(name, false);
    if (info) out.push(info);
  }
  const disabled = getDisabledPluginsRoot();
  if (disabled && fs.existsSync(disabled)) {
    for (const name of readDirs(disabled)) {
      const info = readPluginInfo(name, true);
      if (info) out.push(info);
    }
  }
  return out;
}
