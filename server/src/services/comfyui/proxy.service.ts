// TCP reverse proxy fronting ComfyUI's native HTTP+WS server. Listens on
// env.COMFYUI_PROXY_PORT (default 8190) and forwards to ComfyUI's internal
// port (env.COMFYUI_PORT, default 8188). When ComfyUI is unreachable we
// serve a small English "unavailable" HTML page so the user-facing URL
// never 404s.
//
// Launcher used the `http-proxy` package which we don't carry as a
// dependency. The same behaviour is achieved here with `http-proxy-middleware`
// (already in studio's deps), configured with `ws: true` and an error handler
// that catches upstream drops so the host process never crashes on them.

import * as http from 'http';
import { createProxyMiddleware, type Options } from 'http-proxy-middleware';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { isComfyUIRunning } from './utils.js';
import { getNotRunningHtml } from './htmlGenerator.js';

function buildProxyOptions(): Options {
  return {
    target: `http://localhost:${env.COMFYUI_PORT}`,
    changeOrigin: true,
    ws: true,
    // http-proxy-middleware surfaces upstream errors via the shared
    // logger instead of `console.*`. Never let them crash the host.
    on: {
      error: (err) => {
        logger.error('comfyui proxy error', { message: String(err) });
      },
    },
  };
}

/**
 * Create an HTTP server that reverse-proxies to ComfyUI. The returned server
 * is not yet listening; the caller invokes `.listen(port, ...)`.
 */
export function createComfyUIProxy(): http.Server {
  const proxy = createProxyMiddleware(buildProxyOptions());
  const server = http.createServer((req, res) => {
    void (async () => {
      const running = await isComfyUIRunning();
      if (running) {
        // http-proxy-middleware expects an Express-style signature. Pass a
        // no-op next so any unmatched request simply drops into a 404 path
        // handled by the proxy itself.
        (proxy as unknown as (
          req: http.IncomingMessage,
          res: http.ServerResponse,
          next: (err?: unknown) => void,
        ) => void)(req, res, () => {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
        });
      } else {
        res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getNotRunningHtml());
      }
    })();
  });
  server.on('upgrade', (req, socket, head) => {
    void (async () => {
      const running = await isComfyUIRunning();
      if (running) {
        const upgradeProxy = proxy as unknown as {
          upgrade: (r: http.IncomingMessage, s: unknown, h: Buffer) => void;
        };
        upgradeProxy.upgrade(req, socket, head);
      } else {
        socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      }
    })();
  });
  server.on('error', (err) => {
    logger.error('comfyui proxy server error', { message: String(err) });
  });
  return server;
}

/**
 * Convenience helper: create + start listening. Returns the server handle.
 * When COMFYUI_PROXY_PORT is 0 (disabled), returns null without binding.
 */
export function startComfyUIProxy(): http.Server | null {
  const port = env.COMFYUI_PROXY_PORT;
  if (!port) {
    logger.info('comfyui proxy disabled (COMFYUI_PROXY_PORT=0)');
    return null;
  }
  const server = createComfyUIProxy();
  server.listen(port, () => {
    logger.info(`comfyui proxy listening on port ${port}`);
  });
  return server;
}
