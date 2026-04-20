// pip source (index-url) get/set. Ported from launcher's python.controller.
// Stores the user-visible source under the studio config root, not CWD.

import fs from 'fs';
import { atomicWrite } from '../../lib/fs.js';
import { paths } from '../../config/paths.js';

const DEFAULT_SOURCE = 'https://pypi.org/simple';

/** Read the pip index-url currently configured, or the default if unset. */
export function getPipSource(): string {
  try {
    if (!fs.existsSync(paths.pipConfigPath)) return DEFAULT_SOURCE;
    const content = fs.readFileSync(paths.pipConfigPath, 'utf-8');
    const match = content.match(/index-url\s*=\s*(.+)/);
    if (match && match[1]) return match[1].trim();
    return DEFAULT_SOURCE;
  } catch {
    return DEFAULT_SOURCE;
  }
}

/** Write the pip index-url. Validates that `source` is a http(s) URL. */
export function setPipSource(source: string): void {
  if (!source || typeof source !== 'string') {
    throw new Error('Source URL is required');
  }
  const trimmed = source.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error('Source must be an http(s) URL');
  }
  const body = `[global]\nindex-url = ${trimmed}\n`;
  atomicWrite(paths.pipConfigPath, body, { mode: 0o644 });
}
