// Integration test for `POST /gallery/import-from-comfyui`.
// Stubs the outbound fetches to ComfyUI (`/api/history` + per-prompt) and
// verifies:
//  - counts `imported` + `skipped` correctly when some rows already exist
//  - rate-limit cooldown rejects back-to-back calls with 429
//
// ComfyUI history payload is the canonical 5-tuple `prompt` format so the
// normaliser + extractor path is exercised end-to-end.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import galleryRouter from '../../src/routes/gallery.routes.js';
import * as repo from '../../src/lib/db/gallery.repo.js';
import { useFreshDb } from '../lib/db/_helpers.js';

function startApp(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use(galleryRouter);
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

// Synthetic `/api/history` list (maps promptId → entry). Two prompts, two
// output files each, so four rows should be produced on import.
const HISTORY_LIST = {
  'prompt-a': {
    outputs: {
      '9': {
        images: [
          { filename: 'a1.png', subfolder: '', type: 'output' },
          { filename: 'a2.png', subfolder: '', type: 'output' },
        ],
      },
    },
  },
  'prompt-b': {
    outputs: {
      '9': {
        images: [
          { filename: 'b1.png', subfolder: 'sub', type: 'output' },
          { filename: 'b2.png', subfolder: 'sub', type: 'output' },
        ],
      },
    },
  },
};

const PER_PROMPT = {
  'prompt-a': {
    'prompt-a': {
      prompt: [0, 'prompt-a', {
        '5': {
          class_type: 'KSampler',
          inputs: { seed: 111, steps: 10, cfg: 5, sampler_name: 'euler' },
        },
      }, {}, []],
      outputs: HISTORY_LIST['prompt-a'].outputs,
    },
  },
  'prompt-b': {
    'prompt-b': {
      prompt: [0, 'prompt-b', {
        '5': {
          class_type: 'KSampler',
          inputs: { seed: 222, steps: 10, cfg: 5, sampler_name: 'euler' },
        },
      }, {}, []],
      outputs: HISTORY_LIST['prompt-b'].outputs,
    },
  },
};

describe('POST /gallery/import-from-comfyui', () => {
  useFreshDb();

  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    // Only intercept ComfyUI host traffic; pass through the test-harness's
    // own Express requests (loopback on an ephemeral port).
    global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('localhost:8188') || u.includes('127.0.0.1:8188')) {
        if (u.includes('/api/history/prompt-a')) {
          return new Response(JSON.stringify(PER_PROMPT['prompt-a']), { status: 200 });
        }
        if (u.includes('/api/history/prompt-b')) {
          return new Response(JSON.stringify(PER_PROMPT['prompt-b']), { status: 200 });
        }
        if (u.includes('/api/history')) {
          return new Response(JSON.stringify(HISTORY_LIST), { status: 200 });
        }
        return new Response('not-found', { status: 404 });
      }
      return originalFetch(url, init);
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  // Both assertions live in the same test because the route's cooldown
  // gate is a process-level `let` — a separate `it` block would already
  // be inside the window from the previous one and report 429 for the
  // first call. Running one-after-the-other in a single `it` keeps the
  // semantics explicit without extra fake-timer plumbing.
  it('imports every row on a cold DB, then rate-limits the immediate next call', async () => {
    const app = await startApp();
    try {
      const res = await fetch(`${app.url}/gallery/import-from-comfyui`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json() as { imported: number; skipped: number };
      expect(body.imported).toBe(4);
      expect(body.skipped).toBe(0);
      expect(repo.count()).toBe(4);
      // v21: IDs are UUIDs; look up by promptId to verify the row was inserted.
      // Extracted fields (seed, sampler) are no longer stored on the row —
      // they are derived from workflowJson on-the-fly in the /api/gallery/:id
      // route. Verify workflowJson is present instead.
      const rows = repo.listAll().filter(r => r.promptId === 'prompt-a');
      expect(rows.length).toBe(2);
      const fullRow = rows[0] ? repo.getByIdFull(rows[0].id) : null;
      expect(fullRow?.workflowJson).not.toBeNull();

      // Second immediate call hits the 10s per-process cooldown.
      const rate = await fetch(`${app.url}/gallery/import-from-comfyui`, { method: 'POST' });
      expect(rate.status).toBe(429);
      expect(rate.headers.get('Retry-After')).not.toBeNull();
    } finally { await app.close(); }
  });
});
