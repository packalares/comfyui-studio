// Structure compliance suite. Runs with the rest of the vitest suite so any
// future regression (too-long file, stray process.env, hardcoded IP, import
// cycle) is caught on the next `npx vitest run` instead of at review time.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', 'src');
const ROOT = resolve(HERE, '..');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (st.isFile() && p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const srcFiles = walk(SRC);
const testFiles = walk(resolve(HERE));

describe('file size cap', () => {
  it('every src/*.ts <= 250 lines', () => {
    const offenders: string[] = [];
    for (const f of srcFiles) {
      const lines = readFileSync(f, 'utf8').split(/\r?\n/).length;
      if (lines > 250) offenders.push(`${relative(ROOT, f)} (${lines} lines)`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('env access discipline', () => {
  it('no process.env.* outside src/config/env.ts', () => {
    const offenders: string[] = [];
    for (const f of srcFiles) {
      if (f.endsWith('config/env.ts')) continue;
      const text = readFileSync(f, 'utf8');
      if (/\bprocess\.env\./.test(text)) offenders.push(relative(ROOT, f));
    }
    expect(offenders).toEqual([]);
  });
});

describe('no CJK characters', () => {
  it('none in src/ or tests/', () => {
    const cjk = /[\u4e00-\u9fff]/;
    const offenders: string[] = [];
    for (const f of [...srcFiles, ...testFiles]) {
      const text = readFileSync(f, 'utf8');
      if (cjk.test(text)) offenders.push(relative(ROOT, f));
    }
    expect(offenders).toEqual([]);
  });
});

describe('no hardcoded private IPs', () => {
  it('no 10.x.x.x / 192.168.x.x / 172.16-31.x.x in src/', () => {
    const patterns: RegExp[] = [
      /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,
      /\b192\.168\.\d{1,3}\.\d{1,3}\b/,
      /\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/,
    ];
    const offenders: string[] = [];
    for (const f of srcFiles) {
      const text = readFileSync(f, 'utf8');
      // Strip JS/TS comments and regex-literal contents so the IP guards in
      // models.routes.ts don't trigger the structure test against themselves.
      const stripped = text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|\s)\/\/[^\n]*/g, '$1')
        .replace(/\/\^[^/\n]+\/[gimsuy]*/g, '');
      for (const re of patterns) {
        if (re.test(stripped)) {
          offenders.push(`${relative(ROOT, f)} :: ${re}`);
          break;
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('no hardcoded sensitive strings', () => {
  it('no bitbot / olares / maharbig / packalyst / claude20 leaks', () => {
    const patterns: RegExp[] = [
      /bitbot\.ro/i,
      /olares\.bitbot/i,
      /packalyst@/i,
      /maharbig/i,
      /claude20/i,
    ];
    const offenders: string[] = [];
    for (const f of srcFiles) {
      const text = readFileSync(f, 'utf8');
      for (const re of patterns) {
        if (re.test(text)) {
          offenders.push(`${relative(ROOT, f)} :: ${re}`);
          break;
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ---- Circular-import detector ----
// AST-free: parse each file's bare `import ... from './X'` or `'../Y/Z'`
// statements, resolve to a relative path inside src/, and run DFS. A cycle
// involving any two of our own modules is a failure.
function collectImports(filePath: string): string[] {
  const text = readFileSync(filePath, 'utf8');
  const out: string[] = [];
  const re = /^(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"];?/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const spec = m[1];
    if (spec.startsWith('.')) out.push(spec);
  }
  return out;
}

function resolveSpec(fromFile: string, spec: string): string | null {
  let candidate = resolve(dirname(fromFile), spec);
  // `.js` specifier -> `.ts` source on disk
  if (candidate.endsWith('.js')) candidate = candidate.slice(0, -3) + '.ts';
  else if (!candidate.endsWith('.ts')) candidate = candidate + '.ts';
  try {
    if (statSync(candidate).isFile()) return candidate;
  } catch { /* try index */ }
  const idx = candidate.replace(/\.ts$/, '/index.ts');
  try {
    if (statSync(idx).isFile()) return idx;
  } catch { /* not found */ }
  return null;
}

describe('no circular imports', () => {
  it('src/ module graph is a DAG', () => {
    const graph = new Map<string, string[]>();
    for (const f of srcFiles) {
      const deps: string[] = [];
      for (const spec of collectImports(f)) {
        const resolved = resolveSpec(f, spec);
        if (resolved && resolved.startsWith(SRC)) deps.push(resolved);
      }
      graph.set(f, deps);
    }
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>();
    const cycles: string[] = [];
    const stack: string[] = [];
    function dfs(node: string): void {
      const c = color.get(node) ?? WHITE;
      if (c === BLACK) return;
      if (c === GRAY) {
        const hit = stack.indexOf(node);
        const loop = stack.slice(hit >= 0 ? hit : 0).concat(node);
        cycles.push(loop.map(n => relative(ROOT, n)).join(' -> '));
        return;
      }
      color.set(node, GRAY);
      stack.push(node);
      for (const next of graph.get(node) || []) dfs(next);
      stack.pop();
      color.set(node, BLACK);
    }
    for (const f of srcFiles) dfs(f);
    expect(cycles).toEqual([]);
  });
});
