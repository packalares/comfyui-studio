// Server-Sent Events helper.
//
// Wraps an Express `Response` in a typed emitter that validates every event
// payload against the route's `SseRouteSpec`, writes the canonical 3-line
// wire frame, and keeps the connection alive through proxy idle timeouts via
// 15s heartbeats. On client disconnect the helper clears the heartbeat,
// invokes the supplied `onClose`, and turns subsequent emits into no-ops so
// late producer code (LLM stream, polling loop) doesn't crash the process.
//
// The MCP and template-import endpoints hand-roll SSE today; Wave 3 migrates
// them onto this helper. New endpoints should use it from the start.

import type { Request, Response } from 'express';
import { z } from 'zod';
import type { SseEventMap, SseRouteSpec } from '../contracts/sse.contract.js';
import { logger } from './logger.js';

const DEFAULT_HEARTBEAT_MS = 15_000;

export interface SseStream<EventMap extends SseEventMap> {
  emit<K extends keyof EventMap & string>(name: K, data: z.infer<EventMap[K]>): Promise<void>;
  emitTerminal<K extends keyof EventMap & string>(name: K, data: z.infer<EventMap[K]>): Promise<void>;
  close(): void;
  readonly closed: boolean;
}

export interface OpenSseStreamOptions {
  onClose?: () => void;
  heartbeatMs?: number;
}

// Escape an SSE `data:` line. The wire format is line-oriented: a literal
// newline inside `data:` would split the frame across two events. We collapse
// CR/LF in the JSON payload (JSON.stringify already escapes nested newlines
// inside strings, so this only catches the outer separator if a caller ever
// hands us a pre-stringified payload). One JSON literal, exactly one line.
function serializePayload(data: unknown): string {
  const json = JSON.stringify(data);
  // JSON.stringify produces a single line for any non-cyclic value, but be
  // defensive: replace any stray CR/LF that snuck in via String.raw etc.
  return json.replace(/\r?\n/g, '\\n');
}

function buildFrame(event: string, data: unknown, id?: string): string {
  const payload = serializePayload(data);
  let frame = `event: ${event}\n` + `data: ${payload}\n`;
  if (id !== undefined) frame += `id: ${id}\n`;
  frame += '\n';
  return frame;
}

// Await `drain` if the socket is buffering. Resolves immediately when the
// write succeeded synchronously, on the next `drain`, or when the response
// closes / errors mid-flight (so a hung client doesn't park the producer).
function waitForDrain(res: Response): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      res.off('drain', done);
      res.off('close', done);
      res.off('error', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
    res.once('error', done);
  });
}

export function openSseStream<EventMap extends SseEventMap>(
  req: Request,
  res: Response,
  spec: SseRouteSpec<EventMap>,
  options: OpenSseStreamOptions = {},
): SseStream<EventMap> {
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;

  let closed = false;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  const terminalSet = new Set<string>(spec.terminalEvents);

  // SSE headers. We deliberately do NOT touch CORS — the cors() middleware in
  // index.ts has already set Access-Control-Allow-Origin on the response by
  // the time the route handler runs. Setting Content-Type to text/event-stream
  // is what tells the browser to keep the connection open and demultiplex
  // frames; `no-cache` blocks intermediary caching; `keep-alive` is redundant
  // on HTTP/1.1 but explicit; `x-accel-buffering: no` disables nginx
  // proxy_buffering so each frame flushes end-to-end.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Disable Nagle on the underlying socket so each `res.write` flushes to
  // the wire without waiting on the 40ms TCP coalescing window.
  const socket = res.socket as (Response['socket'] & { setNoDelay?: (v: boolean) => void }) | null;
  if (socket && typeof socket.setNoDelay === 'function') socket.setNoDelay(true);

  // Some Express versions stall the headers until the first body write. Push
  // an explicit flushHeaders so the client sees the 200 + content-type even
  // before the first event.
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  // Initial comment: signals "stream open" without consuming an event name.
  // EventSource ignores comment lines, but proxies see traffic immediately.
  res.write(': connected\n\n');

  const scheduleHeartbeat = (): void => {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(() => {
      if (closed) return;
      // Comment-form heartbeat. EventSource silently swallows comments, so
      // the keep-alive never surfaces as a stream event to the client.
      const wrote = res.write(': keep-alive\n\n');
      if (!wrote) {
        // Backpressure on a heartbeat is rare but possible; just defer the
        // next tick — `drain` will fire before the next emit goes out.
      }
      scheduleHeartbeat();
    }, heartbeatMs);
    // Heartbeat must not pin the event loop on shutdown.
    if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
  };

  const teardown = (reason: 'client-close' | 'terminal' | 'explicit-close'): void => {
    if (closed) return;
    closed = true;
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
    req.off('close', onReqClose);
    res.off('close', onResClose);
    if (reason !== 'client-close') {
      // Best-effort end — wrapping protects us from "ERR_STREAM_WRITE_AFTER_END"
      // when the socket already closed under us.
      try { res.end(); } catch { /* socket already gone */ }
    }
    if (options.onClose) {
      try { options.onClose(); }
      catch (err) {
        logger.warn('sse: onClose callback threw', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  const onReqClose = (): void => teardown('client-close');
  const onResClose = (): void => teardown('client-close');
  req.once('close', onReqClose);
  res.once('close', onResClose);

  const writeEvent = async <K extends keyof EventMap & string>(
    name: K,
    data: z.infer<EventMap[K]>,
    id?: string,
  ): Promise<void> => {
    if (closed) return;
    const schema = spec.events[name];
    if (!schema) {
      // Programmer bug: emitting an event not declared in the route spec.
      // Surface loudly so it's caught in dev — but do NOT crash the response.
      logger.error('sse: emit for undeclared event', { event: name });
      throw new Error(`sse: event "${name}" is not declared in this route's spec`);
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      logger.error('sse: emit payload failed schema validation', {
        event: name,
        issues: parsed.error.issues,
      });
      throw new Error(`sse: payload for event "${name}" failed schema validation`);
    }

    const frame = buildFrame(name, parsed.data, id);
    const ok = res.write(frame);
    if (!ok) await waitForDrain(res);
    scheduleHeartbeat();
  };

  scheduleHeartbeat();

  const stream: SseStream<EventMap> = {
    async emit(name, data) {
      await writeEvent(name, data);
    },
    async emitTerminal(name, data) {
      await writeEvent(name, data);
      // Terminal events that aren't actually declared as terminal in the spec
      // still close the stream — but log so the spec gets fixed.
      if (!terminalSet.has(name)) {
        logger.warn('sse: emitTerminal called for non-terminal event; closing anyway', {
          event: name,
          declaredTerminal: spec.terminalEvents,
        });
      }
      teardown('terminal');
    },
    close() { teardown('explicit-close'); },
    get closed() { return closed; },
  };

  return stream;
}
