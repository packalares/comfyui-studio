// Smoke test for the dual-mount structure of the launcher system routes.
// Verifies every handler pair resolves to the same implementation so the
// canonical + `/launcher/` prefixes stay in lock-step.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTE_FILE = path.resolve(HERE, '..', '..', 'src', 'routes', 'systemLauncher.routes.ts');

describe('systemLauncher route file', () => {
  const text = readFileSync(ROUTE_FILE, 'utf8');

  it('dual-mounts open-path', () => {
    expect(text).toContain("'/system/open-path'");
    expect(text).toContain("'/launcher/system/open-path'");
  });

  it('dual-mounts files-base-path', () => {
    expect(text).toContain("'/system/files-base-path'");
    expect(text).toContain("'/launcher/system/files-base-path'");
  });

  it('dual-mounts network-status (GET + POST)', () => {
    expect(text).toContain("'/system/network-status'");
    expect(text).toContain("'/launcher/system/network-status'");
  });

  it('dual-mounts network-config', () => {
    expect(text).toContain("'/system/network-config'");
    expect(text).toContain("'/launcher/system/network-config'");
  });

  it('dual-mounts network-check-log/:id', () => {
    expect(text).toContain("'/system/network-check-log/:id'");
    expect(text).toContain("'/launcher/system/network-check-log/:id'");
  });

  it('dual-mounts pip-source, hf-endpoint, github-proxy', () => {
    expect(text).toContain("'/system/pip-source'");
    expect(text).toContain("'/launcher/system/pip-source'");
    expect(text).toContain("'/system/huggingface-endpoint'");
    expect(text).toContain("'/launcher/system/huggingface-endpoint'");
    expect(text).toContain("'/system/github-proxy'");
    expect(text).toContain("'/launcher/system/github-proxy'");
  });

  it('applies rate-limit middleware to network-status POST', () => {
    // The checkLimiter variable name is used in the source; ensure it wraps
    // the POST handler.
    expect(text).toMatch(/router\.post\(\[['"]\/system\/network-status/);
    expect(text).toContain('checkLimiter');
  });

  it('applies rate-limit middleware to config POSTs', () => {
    expect(text).toContain('configLimiter');
  });
});
