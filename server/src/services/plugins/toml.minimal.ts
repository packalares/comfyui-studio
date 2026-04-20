// Very small TOML reader tailored to pyproject.toml / `[tool.comfy]` usage.
// Handles the subset needed by plugin info extraction: sectioned key=value
// pairs, inline arrays of strings, inline arrays of tables (authors = [...])
// , and nested table names. This is NOT a full TOML parser — it rejects
// multiline tables, triple-quoted strings, and other features we don't need.

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
