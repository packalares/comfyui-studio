import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import apiRouter from './routes/api.js';
import { getComfyUIUrl, getQueue, getGalleryItems } from './services/comfyui.js';
import { loadTemplatesFromComfyUI } from './services/templates.js';
import { setDownloadBroadcaster, getAllDownloads } from './services/downloads.js';

const app = express();
const PORT = parseInt(process.env.BACKEND_PORT || process.env.PORT || '3002', 10);
const LAUNCHER_URL = process.env.LAUNCHER_URL || 'http://localhost:3000';

app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.use('/api', apiRouter);

import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(__dirname, '../../dist');
app.use(express.static(distPath));
app.get('*', (_req, res, next) => {
  if (_req.path.startsWith('/api') || _req.path.startsWith('/ws')) return next();
  res.sendFile(path.join(distPath, 'index.html'));
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// ---- Track connected clients for broadcast ----
const clients = new Set<WebSocket>();

function broadcast(message: object) {
  const data = JSON.stringify(message);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

// ---- Single launcher-status poller, broadcast on change ----
let lastLauncherStatus: unknown = null;
let lastLauncherStatusJson = '';

// Launcher returns uptime with hardcoded Chinese units (秒/分/小时/分钟).
// Translate to English for display.
function translateUptime(uptime: unknown): unknown {
  if (typeof uptime !== 'string') return uptime;
  return uptime
    .replace(/(\d+)小时(\d+)分钟/, '$1h $2m')
    .replace(/(\d+)分(\d+)秒/, '$1m $2s')
    .replace(/(\d+)秒/, '$1s')
    .replace(/(\d+)分钟/, '$1m');
}

async function pollLauncherStatus() {
  let data: Record<string, unknown>;
  try {
    const res = await fetch(`${LAUNCHER_URL}/api/status`);
    data = res.ok ? await res.json() as Record<string, unknown> : { reachable: false, status: res.status };
  } catch (err) {
    data = { reachable: false, error: String(err) };
  }
  if ('uptime' in data) data.uptime = translateUptime(data.uptime);
  const json = JSON.stringify(data);
  if (json !== lastLauncherStatusJson) {
    lastLauncherStatus = data;
    lastLauncherStatusJson = json;
    broadcast({ type: 'launcher-status', data });
  }
}

setInterval(pollLauncherStatus, 5000);
pollLauncherStatus();

// Hook up downloads service so it can broadcast progress to all WS clients.
setDownloadBroadcaster(broadcast);

// ---- Queue & gallery broadcasts ----
// Triggered by ComfyUI WS events. Debounced so bursts of messages (e.g. per-node
// 'executed') collapse into one broadcast.
let queueTimer: NodeJS.Timeout | null = null;
let galleryTimer: NodeJS.Timeout | null = null;

function scheduleQueueBroadcast() {
  if (queueTimer) return;
  queueTimer = setTimeout(async () => {
    queueTimer = null;
    try {
      const queue = await getQueue();
      broadcast({ type: 'queue', data: queue });
    } catch { /* ignore */ }
  }, 100);
}

function scheduleGalleryBroadcast() {
  if (galleryTimer) return;
  galleryTimer = setTimeout(async () => {
    galleryTimer = null;
    try {
      const items = await getGalleryItems();
      broadcast({ type: 'gallery', data: { total: items.length, recent: items.slice(0, 8) } });
    } catch { /* ignore */ }
  }, 500);
}

// ---- Client WS: survives ComfyUI outages, retries upstream automatically ----
wss.on('connection', (clientWs) => {
  clients.add(clientWs);

  if (lastLauncherStatus !== null) {
    clientWs.send(JSON.stringify({ type: 'launcher-status', data: lastLauncherStatus }));
  }
  // Hydrate in-progress downloads so a freshly-loaded page sees them instantly.
  const snapshot = getAllDownloads();
  if (snapshot.length > 0) {
    clientWs.send(JSON.stringify({ type: 'downloads-snapshot', data: snapshot }));
  }

  let comfyWs: WebSocket | null = null;
  let comfyRetryTimer: NodeJS.Timeout | null = null;
  let closed = false;

  const openComfyWs = () => {
    if (closed) return;
    const comfyUrl = getComfyUIUrl().replace(/^http/, 'ws');
    try {
      comfyWs = new WebSocket(`${comfyUrl}/ws?clientId=${crypto.randomUUID()}`);
      comfyWs.on('message', (data) => {
        const str = data.toString();
        if (clientWs.readyState === WebSocket.OPEN) clientWs.send(str);
        // Trigger queue/gallery rebroadcast on relevant comfy events
        try {
          const msg = JSON.parse(str);
          if (msg?.type === 'status') scheduleQueueBroadcast();
          else if (msg?.type === 'executed' || msg?.type === 'execution_complete') {
            scheduleQueueBroadcast();
            scheduleGalleryBroadcast();
          }
        } catch { /* non-JSON */ }
      });
      comfyWs.on('error', () => { /* silent — close handler retries */ });
      comfyWs.on('close', () => {
        comfyWs = null;
        if (!closed) comfyRetryTimer = setTimeout(openComfyWs, 5000);
      });
    } catch {
      if (!closed) comfyRetryTimer = setTimeout(openComfyWs, 5000);
    }
  };

  openComfyWs();

  const cleanup = () => {
    closed = true;
    clients.delete(clientWs);
    if (comfyRetryTimer) clearTimeout(comfyRetryTimer);
    comfyWs?.close();
  };

  clientWs.on('close', cleanup);
  clientWs.on('error', cleanup);
});

async function start() {
  const comfyUrl = getComfyUIUrl();
  console.log(`ComfyUI URL: ${comfyUrl}`);
  console.log(`Launcher URL: ${LAUNCHER_URL}`);

  server.listen(PORT, () => {
    console.log(`ComfyUI Studio server running on port ${PORT}`);
  });

  async function loadWithRetry(retries: number, delay: number) {
    await loadTemplatesFromComfyUI(comfyUrl);
    const { getTemplates } = await import('./services/templates.js');
    if (getTemplates().length === 0 && retries > 0) {
      console.log(`Templates not available, retrying in ${delay / 1000}s... (${retries} retries left)`);
      setTimeout(() => loadWithRetry(retries - 1, delay), delay);
    }
  }
  loadWithRetry(12, 10000);
}

start().catch(console.error);
