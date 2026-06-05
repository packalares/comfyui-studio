// Integration tests for GET /api/jobs/:id and GET /api/jobs/:id/events

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import { authedFetch } from '../helpers/authedFetch.js';
import { useFreshDb } from '../lib/db/_helpers.js';
import * as repo from '../../src/lib/db/gallery.repo.js';
import * as eventBus from '../../src/services/jobs/eventBus.js';

// Mock comfyui api to avoid network calls.
const mockGetQueuePromptIds = vi.fn<[], Promise<Set<string>>>();
const mockGetHistoryForPrompt = vi.fn<[string], Promise<Record<string, unknown> | null>>();

vi.mock('../../src/services/comfyui/api.js', () => ({
  getQueuePromptIds: () => mockGetQueuePromptIds(),
  getHistoryForPrompt: (id: string) => mockGetHistoryForPrompt(id),
  getComfyUIUrl: () => 'http://localhost:8188',
}));

const { default: jobsRouter } = await import('../../src/routes/jobs.routes.js');

function startApp(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use(jobsRouter);
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

useFreshDb();

beforeEach(() => {
  eventBus._resetForTests();
  vi.clearAllMocks();
});

afterEach(() => {
  eventBus._resetForTests();
});

// ---- GET /api/jobs/:id -------------------------------------------------------

describe('GET /api/jobs/:id', () => {
  it('returns 404 when job is unknown', async () => {
    mockGetQueuePromptIds.mockResolvedValue(new Set());
    mockGetHistoryForPrompt.mockResolvedValue(null);
    const app = await startApp();
    try {
      const res = await authedFetch(`${app.url}/jobs/unknown-pid`);
      expect(res.status).toBe(404);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('not_found');
    } finally { await app.close(); }
  });

  it('returns running status for in-queue job', async () => {
    mockGetQueuePromptIds.mockResolvedValue(new Set(['queued-pid']));
    mockGetHistoryForPrompt.mockResolvedValue(null);
    const app = await startApp();
    try {
      const res = await authedFetch(`${app.url}/jobs/queued-pid`);
      expect(res.status).toBe(200);
      const body = await res.json() as { data: { status: string; id: string } };
      expect(body.data.status).toBe('running');
      expect(body.data.id).toBe('queued-pid');
    } finally { await app.close(); }
  });

  it('returns success + items for a completed job with gallery rows', async () => {
    mockGetQueuePromptIds.mockResolvedValue(new Set());
    mockGetHistoryForPrompt.mockResolvedValue({ status: { messages: [] } });
    repo.insert({
      id: 'gallery-r1', filename: 'out.png', subfolder: '', type: 'output',
      mediaType: 'image', url: '/api/view?filename=out.png', promptId: 'done-p1',
      createdAt: 1000,
    });
    const app = await startApp();
    try {
      const res = await authedFetch(`${app.url}/jobs/done-p1`);
      expect(res.status).toBe(200);
      const body = await res.json() as { data: { status: string; result?: { items: unknown[] } } };
      expect(body.data.status).toBe('success');
      expect(body.data.result?.items).toHaveLength(1);
    } finally { await app.close(); }
  });
});

// ---- GET /api/jobs/:id/events (SSE) ----------------------------------------

describe('GET /api/jobs/:id/events', () => {
  it('streams status and done events and closes on terminal', async () => {
    mockGetQueuePromptIds.mockResolvedValue(new Set(['live-pid']));
    mockGetHistoryForPrompt.mockResolvedValue(null);

    const app = await startApp();
    try {
      // Open the SSE stream.
      const fetchPromise = authedFetch(`${app.url}/jobs/live-pid/events`, {
        headers: { Accept: 'text/event-stream' },
      });

      // Small delay so the handler subscribes before we emit.
      await new Promise<void>((r) => setTimeout(r, 50));

      // Emit a progress event then a done event.
      eventBus.emit('live-pid', { type: 'progress', data: { node: 'n1', step: 5, total: 10 } });
      eventBus.emit('live-pid', { type: 'done', data: { status: 'success' } });

      const res = await fetchPromise;
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      const text = await res.text();
      // Should contain the progress event and the done event.
      expect(text).toContain('event: progress');
      expect(text).toContain('event: done');
    } finally { await app.close(); }
  });

  it('replays buffered events when Last-Event-ID header is sent', async () => {
    mockGetQueuePromptIds.mockResolvedValue(new Set());
    mockGetHistoryForPrompt.mockResolvedValue(null);

    // Pre-emit two events before the client connects.
    eventBus.emit('replay-pid', { type: 'status', data: { status: 'running' } });
    eventBus.emit('replay-pid', { type: 'progress', data: { node: 'n1', step: 1, total: 5 } });
    // Emit a done event so the stream closes.
    eventBus.emit('replay-pid', { type: 'done', data: {} });

    const app = await startApp();
    try {
      // Client sends Last-Event-ID: -1 to request all buffered events.
      const res = await authedFetch(`${app.url}/jobs/replay-pid/events`, {
        headers: { Accept: 'text/event-stream', 'Last-Event-ID': '-1' },
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      // Should include the replayed status event.
      expect(text).toContain('event: status');
    } finally { await app.close(); }
  });

  it('unsubscribes from bus when client disconnects (listenerCount returns to 0)', async () => {
    mockGetQueuePromptIds.mockResolvedValue(new Set(['lc-pid']));
    mockGetHistoryForPrompt.mockResolvedValue(null);

    const app = await startApp();
    const ac = new AbortController();
    try {
      // Open SSE with an abort so we can close the client side.
      const fetchPromise = authedFetch(`${app.url}/jobs/lc-pid/events`, {
        headers: { Accept: 'text/event-stream' },
        signal: ac.signal,
      });

      // Wait for subscription to register.
      await new Promise<void>((r) => setTimeout(r, 80));
      expect(eventBus.listenerCount('lc-pid')).toBe(1);

      // Abort the client request (simulates disconnect).
      ac.abort();
      await fetchPromise.catch(() => undefined); // ignore AbortError

      // Give the server a tick to process the close event.
      await new Promise<void>((r) => setTimeout(r, 80));
      expect(eventBus.listenerCount('lc-pid')).toBe(0);
    } finally { await app.close(); }
  });
});

// ---- generate route response: includes statusUrl + streamUrl ----------------

describe('generate route response shape', () => {
  it('POST /api/generate includes statusUrl and streamUrl', async () => {
    // Tested via the contract schema — just verify the schema accepts expected fields.
    const { GenerateResponseSchema } = await import('../../src/contracts/generate.contract.js');
    const parsed = GenerateResponseSchema.safeParse({
      promptId: 'abc123',
      statusUrl: '/api/jobs/abc123',
      streamUrl: '/api/jobs/abc123/events',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.statusUrl).toBe('/api/jobs/abc123');
      expect(parsed.data.streamUrl).toBe('/api/jobs/abc123/events');
    }
  });
});
