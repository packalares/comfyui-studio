// Introspection helpers for an installed ComfyUI.
//
// Both exported functions are **process-lifetime cached**: the first call
// performs the I/O (file read or subprocess), stores the result, and all
// subsequent calls return the cached value. There is intentionally NO
// cache-invalidation mechanism — the assumption is that ComfyUI's install is
// static for the lifetime of the Studio process. Restart Studio to pick up
// a ComfyUI upgrade.

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

// ---- Types ----

export interface ComfyValidFlag {
  optionString: string;    // e.g. '--front-end-version'
  help?: string;           // argparse help string
  type: 'string' | 'number' | 'flag';
  defaultValue?: string | number | boolean | null;
}

// ---- Internal cache ----

let _frontendVersion: string | null | undefined = undefined;   // undefined = not yet read
let _validFlags: readonly ComfyValidFlag[] | null | undefined = undefined;

// ---- Helpers ----

function comfyuiPath(): string {
  return env.COMFYUI_PATH || '/root/ComfyUI';
}

// ---- Public API ----

/**
 * Read `/root/ComfyUI/requirements.txt` (or `$COMFYUI_PATH/requirements.txt`)
 * and return the frontend version string, e.g.
 *   `'Comfy-Org/ComfyUI_frontend@v1.44.19'`
 *
 * Returns `null` when:
 *  - the file doesn't exist
 *  - `comfyui-frontend-package==` line is absent
 *  - any I/O error occurs
 *
 * Callers MUST fall back when null is returned.
 *
 * **Cache:** result is stored after the first call; subsequent calls are
 * synchronous and return the cached value without touching the filesystem.
 */
export function readRequiredFrontendVersion(): string | null {
  if (_frontendVersion !== undefined) return _frontendVersion;

  const reqPath = path.join(comfyuiPath(), 'requirements.txt');
  try {
    const content = fs.readFileSync(reqPath, 'utf-8');
    // Match lines like: comfyui-frontend-package==1.44.19
    const match = content.match(/^comfyui-frontend-package==(\S+)/im);
    if (match) {
      const version = `Comfy-Org/ComfyUI_frontend@v${match[1]}`;
      logger.info('[comfyIntrospect] resolved frontend version from requirements.txt', { version });
      _frontendVersion = version;
      return version;
    }
    logger.warn('[comfyIntrospect] comfyui-frontend-package not found in requirements.txt');
    _frontendVersion = null;
    return null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('[comfyIntrospect] could not read requirements.txt', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
    _frontendVersion = null;
    return null;
  }
}

/**
 * Run a Python one-liner inside `$COMFYUI_PATH` to extract all valid CLI
 * flags from ComfyUI's argparse parser.
 *
 * Returns the flag list on success, or `null` when:
 *  - Python is unavailable
 *  - `comfy.cli_args` cannot be imported (ComfyUI path wrong / not installed)
 *  - The subprocess exits non-zero
 *  - stdout is not valid JSON
 *  - any other error occurs
 *
 * Studio MUST keep booting even when this returns null — all consumers fall
 * back to the static deny-list / curated metadata.
 *
 * **Cache:** the subprocess runs AT MOST ONCE per process lifetime. All
 * subsequent calls return the cached result synchronously.
 *
 * Python one-liner used:
 * ```
 * import comfy.cli_args, json
 * out=[]
 * for a in comfy.cli_args.parser._actions:
 *   os_list=getattr(a,'option_strings',[])
 *   if not os_list: continue
 *   key=os_list[-1]
 *   klass=type(a).__name__
 *   if klass in ('_StoreTrueAction','_StoreFalseAction','_AppendConstAction'):
 *     t='flag'
 *   elif getattr(a,'type',None) is int:
 *     t='number'
 *   else:
 *     t='string'
 *   out.append({'optionString':key,'help':getattr(a,'help',''),'type':t,'default':a.default})
 * print(json.dumps(out))
 * ```
 */
export function readValidComfyFlags(): readonly ComfyValidFlag[] | null {
  if (_validFlags !== undefined) return _validFlags;

  const cwd = comfyuiPath();
  const pythonBin = env.PYTHON_PATH || 'python3';

  // Single-line script (no embedded newlines needed — using semicolons)
  const script = [
    'import comfy.cli_args, json',
    'out=[]',
    'for a in comfy.cli_args.parser._actions:',
    '  os_list=getattr(a,"option_strings",[])',
    '  if not os_list: continue',
    '  key=os_list[-1]',
    '  klass=type(a).__name__',
    '  if klass in ("_StoreTrueAction","_StoreFalseAction","_AppendConstAction"):',
    '    t="flag"',
    '  elif getattr(a,"type",None) is int:',
    '    t="number"',
    '  else:',
    '    t="string"',
    '  out.append({"optionString":key,"help":getattr(a,"help","") or "","type":t,"default":a.default})',
    'print(json.dumps(out))',
  ].join('\n');

  try {
    const stdout = execFileSync(pythonBin, ['-c', script], {
      cwd,
      timeout: 8000,
      encoding: 'utf-8',
    });

    type RawEntry = {
      optionString: unknown;
      help?: unknown;
      type?: unknown;
      default?: unknown;
    };

    const raw: unknown = JSON.parse(stdout.trim());
    if (!Array.isArray(raw)) {
      logger.warn('[comfyIntrospect] argparse dump was not an array');
      _validFlags = null;
      return null;
    }

    const flags: ComfyValidFlag[] = (raw as RawEntry[]).flatMap((entry) => {
      const optionString = typeof entry.optionString === 'string' ? entry.optionString : null;
      if (!optionString) return [];
      const rawType = entry.type;
      const flagType: ComfyValidFlag['type'] =
        rawType === 'flag' ? 'flag'
        : rawType === 'number' ? 'number'
        : 'string';
      const rawDefault = entry.default;
      const defaultValue: ComfyValidFlag['defaultValue'] =
        rawDefault === null || rawDefault === undefined ? null
        : typeof rawDefault === 'string' ? rawDefault
        : typeof rawDefault === 'number' ? rawDefault
        : typeof rawDefault === 'boolean' ? rawDefault
        : null;
      return [{
        optionString,
        help: typeof entry.help === 'string' ? entry.help : undefined,
        type: flagType,
        defaultValue,
      }];
    });

    logger.info('[comfyIntrospect] discovered valid ComfyUI flags via argparse', { count: flags.length });
    _validFlags = flags;
    return flags;
  } catch (err) {
    logger.warn('[comfyIntrospect] argparse introspection failed; falling back to static list', {
      message: err instanceof Error ? err.message : String(err),
    });
    _validFlags = null;
    return null;
  }
}

// ---- Test-only cache reset (not exported in types, for vitest vi.mock usage) ----
// Called by tests that need to swap mock return values between cases.
export function _resetIntrospectCache(): void {
  _frontendVersion = undefined;
  _validFlags = undefined;
}
