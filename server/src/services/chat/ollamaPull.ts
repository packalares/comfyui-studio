// Streams Ollama's `POST /api/pull` NDJSON response to the WS bus.
//
// Ollama emits one JSON object per chunk: `{ status, digest?, total?, completed?, error? }`.
// We translate them to `model:pull:progress` envelopes (with computed
// percent), and emit `model:pull:done` / `model:pull:error` when the stream
// terminates. Concurrent pulls keyed by model name are deduplicated; a
// second pull for the same name returns the existing taskId.

import * as settings from '../settings.js';
import { emitChatEvent } from './broadcaster.js';

interface ActivePull { taskId: string; abort: AbortController }

const active = new Map<string, ActivePull>();

function makeId(): string {
  return 'pull_' + Math.random().toString(36).slice(2, 12);
}

export interface StartPullResult {
  taskId: string;
  alreadyActive: boolean;
}

export function startPull(name: string): StartPullResult {
  const existing = active.get(name);
  if (existing) return { taskId: existing.taskId, alreadyActive: true };
  const taskId = makeId();
  const abort = new AbortController();
  active.set(name, { taskId, abort });
  void runPull(name, taskId, abort).finally(() => active.delete(name));
  return { taskId, alreadyActive: false };
}

async function runPull(name: string, taskId: string, abort: AbortController): Promise<void> {
  const baseUrl = settings.getOllamaUrl();
  emitChatEvent({
    type: 'model:pull:progress',
    data: { name, taskId, percent: 0, status: 'starting' },
  });
  try {
    const res = await fetch(`${baseUrl}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, stream: true }),
      signal: abort.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`upstream ${res.status} ${res.statusText}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let lastErr: string | null = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed) as Record<string, unknown>;
          if (typeof obj.error === 'string') { lastErr = obj.error; continue; }
          const status = typeof obj.status === 'string' ? obj.status : '';
          const total = typeof obj.total === 'number' ? obj.total : undefined;
          const completed = typeof obj.completed === 'number' ? obj.completed : undefined;
          const digest = typeof obj.digest === 'string' ? obj.digest : undefined;
          let percent = 0;
          if (total && total > 0 && completed !== undefined) {
            percent = Math.min(100, Math.round((completed / total) * 100));
          } else if (status === 'success') {
            percent = 100;
          }
          emitChatEvent({
            type: 'model:pull:progress',
            data: { name, taskId, status, digest, total, completed, percent },
          });
        } catch { /* malformed NDJSON line — skip */ }
      }
    }
    if (lastErr) throw new Error(lastErr);
    emitChatEvent({ type: 'model:pull:done', data: { name, taskId } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitChatEvent({ type: 'model:pull:error', data: { name, taskId, error: message } });
  }
}

export function cancelPull(name: string): boolean {
  const entry = active.get(name);
  if (!entry) return false;
  entry.abort.abort();
  active.delete(name);
  return true;
}
