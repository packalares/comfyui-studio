// Typed UI consumer for SSE endpoints.
//
// openSseStream(url, handlers, opts) opens a native EventSource (or falls
// back to a manual fetch-based reader when the EventSource API is unavailable
// — e.g. in tests). Each incoming event name is dispatched to the matching
// handler; unknown event names are silently ignored. The returned object lets
// the caller close the connection early.
//
// Event payload parsing: each frame's `data` field is JSON.parsed. A parse
// failure logs a warning and skips the frame; it does NOT close the stream.

import { ApiClientError } from './error.js';

export interface SseHandlers {
  [event: string]: (data: unknown) => void;
}

export interface SseStreamHandle {
  close: () => void;
}

export interface OpenSseStreamOptions {
  /** Called when the connection closes (error or explicit close). */
  onClose?: (err?: ApiClientError) => void;
  /** Optional AbortSignal to cancel the stream externally. */
  signal?: AbortSignal;
  /** Custom headers (e.g. Authorization for external consumers). */
  headers?: Record<string, string>;
  /** Base URL prefix. Defaults to '/api'. */
  baseUrl?: string;
}

const DEFAULT_BASE = '/api';

/** Open an SSE connection to `path` (relative to baseUrl) and dispatch
 *  incoming events to the matching handler in `handlers`. Returns a handle
 *  whose `close()` tears down the connection. */
export function openSseStream(
  path: string,
  handlers: SseHandlers,
  opts: OpenSseStreamOptions = {},
): SseStreamHandle {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE;
  const url = `${baseUrl}${path}`;

  let closed = false;
  const ac = new AbortController();

  // Propagate external signal.
  opts.signal?.addEventListener('abort', () => { ac.abort(); });

  function handleClose(err?: ApiClientError): void {
    if (closed) return;
    closed = true;
    opts.onClose?.(err);
  }

  // Use fetch + manual frame parsing so we can pass custom headers and the
  // AbortController. EventSource doesn't support either.
  void (async () => {
    let res: Response;
    try {
      const headers: Record<string, string> = {
        Accept: 'text/event-stream',
        ...opts.headers,
      };
      res = await fetch(url, { headers, signal: ac.signal });
    } catch (err) {
      if (closed) return;
      const isAbort = err instanceof DOMException && err.name === 'AbortError';
      handleClose(
        isAbort
          ? undefined
          : new ApiClientError({ code: 'upstream_unavailable', status: 0, message: 'SSE connection failed' }),
      );
      return;
    }

    if (!res.ok) {
      handleClose(
        new ApiClientError({
          code: 'upstream_unavailable',
          status: res.status,
          message: `SSE endpoint returned ${res.status}`,
        }),
      );
      return;
    }

    const reader = res.body?.getReader();
    if (!reader) {
      handleClose(new ApiClientError({ code: 'internal_error', status: 0, message: 'No response body' }));
      return;
    }

    const decoder = new TextDecoder();
    let buf = '';

    // SSE frame state.
    let eventName = 'message';
    let dataLines: string[] = [];

    function dispatchFrame(): void {
      if (dataLines.length === 0) return;
      const rawData = dataLines.join('\n');
      const handler = handlers[eventName];
      if (handler) {
        try {
          const parsed = JSON.parse(rawData) as unknown;
          handler(parsed);
        } catch {
          // Ignore malformed JSON; don't kill the stream.
        }
      }
      // Reset frame accumulators.
      eventName = 'message';
      dataLines = [];
    }

    try {
      while (!closed) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        // Process complete lines.
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);

          if (line === '') {
            // Empty line = end of SSE frame.
            dispatchFrame();
          } else if (line.startsWith('event:')) {
            eventName = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trimStart());
          }
          // id: / retry: lines are silently skipped.
        }
      }
    } catch (err) {
      if (closed) return;
      const isAbort = err instanceof DOMException && err.name === 'AbortError';
      handleClose(
        isAbort
          ? undefined
          : new ApiClientError({ code: 'upstream_unavailable', status: 0, message: 'SSE stream read error' }),
      );
      return;
    } finally {
      try { reader.cancel(); } catch { /* ignore */ }
    }

    handleClose();
  })();

  return {
    close() {
      if (closed) return;
      closed = true;
      ac.abort();
    },
  };
}

/** Typed helper for chat conversation streams. Opens the SSE endpoint for a
 *  specific conversation and maps each event name to a strongly-typed handler.
 *  Returns a handle to close the stream early. */
export interface ChatSseHandlers {
  onChunk?: (data: { msgId: string; delta: string }) => void;
  onReasoning?: (data: { msgId: string; delta: string }) => void;
  onTool?: (data: { msgId: string; part: unknown }) => void;
  onStatus?: (data: { msgId: string; code?: string; message?: string }) => void;
  onDone?: (data: { msgId: string; stats: unknown; usage?: unknown }) => void;
  onError?: (data: { msgId: string; error: string }) => void;
  onClose?: (err?: ApiClientError) => void;
}

export function openChatSseStream(
  conversationId: string,
  handlers: ChatSseHandlers,
  opts: Omit<OpenSseStreamOptions, 'onClose'> = {},
): SseStreamHandle {
  const raw: SseHandlers = {};
  if (handlers.onChunk) raw['chunk'] = (d) => { handlers.onChunk!(d as { msgId: string; delta: string }); };
  if (handlers.onReasoning) raw['reasoning'] = (d) => { handlers.onReasoning!(d as { msgId: string; delta: string }); };
  if (handlers.onTool) raw['tool'] = (d) => { handlers.onTool!(d as { msgId: string; part: unknown }); };
  if (handlers.onStatus) raw['status'] = (d) => { handlers.onStatus!(d as { msgId: string; code?: string; message?: string }); };
  if (handlers.onDone) raw['done'] = (d) => { handlers.onDone!(d as { msgId: string; stats: unknown; usage?: unknown }); };
  if (handlers.onError) raw['error'] = (d) => { handlers.onError!(d as { msgId: string; error: string }); };

  return openSseStream(
    `/chat/conversations/${encodeURIComponent(conversationId)}/stream`,
    raw,
    { ...opts, onClose: handlers.onClose },
  );
}
