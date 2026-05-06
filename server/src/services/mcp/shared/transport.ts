// Common transport helpers: timeout wrapper and abort-signal utilities.

/** Default timeout (ms) for a single MCP request (tools/list, tools/call). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Default timeout (ms) when establishing a connection. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

/**
 * Wrap a promise with a timeout. Rejects with a descriptive Error if the
 * operation does not resolve within `ms` milliseconds.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e as Error); },
    );
  });
}

/**
 * Create an AbortController that automatically aborts after `ms` milliseconds.
 * Caller should cancel the returned `cancel()` function if the operation
 * completes early to avoid a dangling timer.
 */
export function timedAbortController(ms: number): {
  controller: AbortController;
  cancel: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    controller,
    cancel: () => clearTimeout(timer),
  };
}
