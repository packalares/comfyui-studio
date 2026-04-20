// Pure metadata parsers for plugin directories. Split out from info.service
// so the reader module stays under the line cap.

import fs from 'fs';
import path from 'path';
import { safeResolve } from '../../lib/fs.js';
import { logger } from '../../lib/logger.js';
import type { PluginMetadata } from './info.types.js';
import { parseMinimalToml } from './toml.minimal.js';

export function readGitInfo(pluginPath: string): { repoUrl: string } | null {
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

export function getPyprojectMetadata(pluginPath: string): Partial<PluginMetadata> {
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

export function getSetupPyMetadata(pluginPath: string): Partial<PluginMetadata> {
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

export interface PluginFileStructure {
  hasInstallScript: boolean;
  hasRequirementsFile: boolean;
  requirements: string[];
}

export function getPluginFileStructure(pluginPath: string): PluginFileStructure {
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
