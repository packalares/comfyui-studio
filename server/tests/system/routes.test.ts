// Smoke test for the route file's structure: each canonical path is mounted
// and the rate-limit middleware is wired in for sensitive POST handlers.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTE_FILE = path.resolve(HERE, '..', '..', 'src', 'routes', 'systemLauncher.routes.ts');

describe('systemLauncher route file', () => {
  const text = readFileSync(ROUTE_FILE, 'utf8');

  it('mounts network-config', () => {
    expect(text).toContain("'/system/network-config'");
  });

  it('mounts pip-source, hf-endpoint, github-proxy', () => {
    expect(text).toContain("'/system/pip-source'");
    expect(text).toContain("'/system/huggingface-endpoint'");
    expect(text).toContain("'/system/github-proxy'");
  });

  it('applies rate-limit middleware to config POSTs', () => {
    expect(text).toContain('configLimiter');
  });
});
