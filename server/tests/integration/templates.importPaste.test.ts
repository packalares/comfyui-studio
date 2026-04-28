// Integration — POST /templates/import/paste — verifies paste-JSON routes
// into the staging pipeline and returns the standard manifest envelope.

import { describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import templatesImportRemote from '../../src/routes/templates.importRemote.js';

function tinyWorkflow(): Record<string, unknown> {
  return {
    nodes: [
      { id: 1, type: 'KSampler' },
      { id: 2, type: 'SaveImage' },
    ],
  };
}

function startApp(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use(templatesImportRemote);
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

describe('POST /templates/import/paste', () => {
  it('stages valid LiteGraph JSON and returns a manifest', async () => {
    const app = await startApp();
    try {
      const res = await fetch(`${app.url}/templates/import/paste`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          json: JSON.stringify(tinyWorkflow()),
          title: 'My Paste',
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as {
        id: string; workflows: Array<{ entryName: string; title: string; nodeCount: number }>;
      };
      expect(body.id).toBeTruthy();
      expect(body.workflows).toHaveLength(1);
      expect(body.workflows[0].title).toBe('My Paste');
      expect(body.workflows[0].nodeCount).toBe(2);
    } finally { await app.close(); }
  });

  it('returns 400 when json is missing', async () => {
    const app = await startApp();
    try {
      const res = await fetch(`${app.url}/templates/import/paste`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    } finally { await app.close(); }
  });

  it('returns 400 for invalid JSON', async () => {
    const app = await startApp();
    try {
      const res = await fetch(`${app.url}/templates/import/paste`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ json: '{not valid' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toMatch(/not valid JSON/i);
    } finally { await app.close(); }
  });

  it('returns 400 for non-LiteGraph JSON', async () => {
    const app = await startApp();
    try {
      const res = await fetch(`${app.url}/templates/import/paste`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ json: JSON.stringify({ foo: 'bar' }) }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      // Paste accepts both raw LiteGraph and TemplateData wrappers; the
      // chokepoint message changed to reflect both shapes.
      expect(body.error).toMatch(/LiteGraph workflow or TemplateData wrapper/);
    } finally { await app.close(); }
  });
});
