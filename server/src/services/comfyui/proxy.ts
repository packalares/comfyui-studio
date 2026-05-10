// TCP reverse proxy fronting ComfyUI's native HTTP+WS server. Listens on
// env.COMFYUI_PROXY_PORT (default 8190) and forwards to ComfyUI's internal
// port (env.COMFYUI_PORT, default 8188). When ComfyUI is unreachable, serves
// a small "unavailable" HTML page so the user-facing URL never 404s.

import * as http from 'http';
import { createProxyMiddleware, type Options } from 'http-proxy-middleware';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { isComfyUIRunning } from './utils.js';

// ---- Fallback HTML ----

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function getNotRunningHtml(): string {
  const adminComfyDomain = escapeHtml(env.DOMAIN_COMFYUI_FOR_ADMIN);
  const adminLauncherDomain = escapeHtml(env.DOMAIN_LAUNCHER_FOR_ADMIN);
  return `<!DOCTYPE html>
<html>
<head>
<title>ComfyUI Unavailable</title>
<meta charset="utf-8">
<style>
  body { font-family: Arial, sans-serif; display:flex; justify-content:center; align-items:center; height:100vh; margin:0; background:white; }
  .container { text-align:center; padding:2rem; max-width:500px; }
  h1 { color:#333; font-size:24px; margin-bottom:10px; }
  p { margin:8px 0 20px; color:#666; font-size:14px; }
  button { border:none; padding:8px 30px; border-radius:8px; cursor:pointer; font-size:16px; font-weight:500; color:white; }
  .retry-btn { background:#4a76fd; }
  .retry-btn:hover { background:#3a66ed; }
  .launcher-btn { background:#28a745; margin-left:10px; }
  .launcher-btn:hover { background:#218838; }
</style>
</head>
<body>
<div class="container">
  <h1>ComfyUI Unavailable</h1>
  <p>The ComfyUI service is currently not running or inaccessible.</p>
  <div id="buttons"></div>
</div>
<script>
(function(){
  var ADMIN_COMFY = ${JSON.stringify(env.DOMAIN_COMFYUI_FOR_ADMIN)};
  var ADMIN_LAUNCHER = ${JSON.stringify(env.DOMAIN_LAUNCHER_FOR_ADMIN)};
  var container = document.getElementById('buttons');
  var host = window.location.hostname;
  var showLauncher = ADMIN_COMFY && host === ADMIN_COMFY && ADMIN_LAUNCHER;
  if (showLauncher) {
    var b = document.createElement('button');
    b.className = 'launcher-btn';
    b.textContent = 'ComfyUI Launcher';
    b.onclick = function(){
      var url = ADMIN_LAUNCHER.indexOf('http') === 0 ? ADMIN_LAUNCHER : 'https://' + ADMIN_LAUNCHER;
      window.location.href = url;
    };
    container.appendChild(b);
  } else {
    var r = document.createElement('button');
    r.className = 'retry-btn';
    r.textContent = 'Retry';
    r.onclick = function(){ window.location.reload(); };
    container.appendChild(r);
  }
  // Reference config vars so linters see them in use when inlined.
  void adminRefs();
  function adminRefs(){ return [${JSON.stringify(adminComfyDomain)}, ${JSON.stringify(adminLauncherDomain)}].length; }
})();
</script>
</body>
</html>`;
}

// ---- Proxy ----

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

// Create an HTTP server that reverse-proxies to ComfyUI. Not yet listening;
// caller invokes `.listen(port, ...)`.
export function createComfyUIProxy(): http.Server {
  const proxy = createProxyMiddleware(buildProxyOptions());
  const server = http.createServer((req, res) => {
    void (async () => {
      const running = await isComfyUIRunning();
      if (running) {
        // http-proxy-middleware expects an Express-style signature.
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

// Convenience helper: create + start listening. Returns null when
// COMFYUI_PROXY_PORT is 0 (disabled).
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
