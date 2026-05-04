// Smoke test for the route file structure: the dynamic POST is mounted, the
// rate-limit middleware is wired in, and `GET /system` carries the folded
// `network` field.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LAUNCHER_FILE = path.resolve(HERE, '..', '..', 'src', 'routes', 'systemLauncher.routes.ts');
const SYSTEM_FILE = path.resolve(HERE, '..', '..', 'src', 'routes', 'system.routes.ts');

describe('systemLauncher route file', () => {
  const text = readFileSync(LAUNCHER_FILE, 'utf8');

  it('mounts a single dynamic POST for every config key', () => {
    expect(text).toContain("'/system/:key'");
  });

  it('applies rate-limit middleware to config POSTs', () => {
    expect(text).toContain('configLimiter');
  });

  it('routes the known config keys via the SETTERS map', () => {
    expect(text).toContain("'pip-source'");
    expect(text).toContain("'huggingface-endpoint'");
    expect(text).toContain("'github-proxy'");
    expect(text).toContain("'plugin-trusted-hosts'");
    expect(text).toContain("'model-trusted-hosts'");
    expect(text).toContain("'pip-allow-private-ip'");
  });
});

describe('system aggregator', () => {
  const text = readFileSync(SYSTEM_FILE, 'utf8');

  it('GET /system carries a folded `network` field', () => {
    expect(text).toContain('network');
    expect(text).toContain('getNetworkConfig');
  });
});
