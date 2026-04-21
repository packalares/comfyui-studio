// Integration test for `GET /api/gallery/thumbnail` — the Wave P video
// poster-frame endpoint. Mocks `child_process.spawn` so we don't require
// a real ffmpeg binary on the test host; verifies the route resolves the
// source path under `${COMFYUI_PATH}/<type>/<subfolder>/<filename>`,
// invokes ffmpeg with `-ss`/`-vframes`, writes the output to the cache
// directory, and streams it back with `Cache-Control: max-age=31536000`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import express from 'express';
import type { AddressInfo } from 'net';

// `spawn` is intercepted via module mock. The handler we substitute records
// the args it was called with, writes a short webp-ish blob to the tmp file
// so the rename step succeeds, and then emits a zero-exit `close` event.
const spawnCalls: Array<{ cmd: string; args: readonly string[] }> = [];

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: (cmd: string, args: readonly string[]) => {
      spawnCalls.push({ cmd, args });
      const proc = new EventEmitter() as EventEmitter & {
        stderr: EventEmitter;
        kill: (s?: NodeJS.Signals) => boolean;
      };
      proc.stderr = new EventEmitter();
      proc.kill = () => true;
      // Mirror ffmpeg writing the tmp file that the service will then rename
      // into place. Args[last] is the tmp path.
      queueMicrotask(() => {
        const tmp = args[args.length - 1];
        try { fs.writeFileSync(tmp, Buffer.from([0x52, 0x49, 0x46, 0x46])); }
        catch { /* surface via close code */ }
        proc.emit('close', 0);
      });
      return proc as unknown as ReturnType<typeof actual.spawn>;
    },
  };
});

async function startApp(): Promise<{ url: string; close: () => Promise<void> }> {
  const { default: router } = await import('../../src/routes/gallery.thumbnail.routes.js');
  const app = express();
  app.use(router);
  return await new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

describe('/gallery/thumbnail', () => {
  let tmpRoot: string;
  let savedComfyPath: string | undefined;

  beforeEach(() => {
    spawnCalls.length = 0;
    vi.resetModules();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vthumb-test-'));
    // Populate a fake "video" under COMFYUI_PATH/output. ffmpeg is mocked so
    // the contents don't matter — only that `resolveViewPath` finds the file.
    const outDir = path.join(tmpRoot, 'output');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'demo.mp4'), Buffer.from([0]));
    savedComfyPath = process.env.COMFYUI_PATH;
    process.env.COMFYUI_PATH = tmpRoot;
  });

  afterEach(() => {
    if (savedComfyPath !== undefined) process.env.COMFYUI_PATH = savedComfyPath;
    else delete process.env.COMFYUI_PATH;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('400 when filename is missing', async () => {
    const app = await startApp();
    try {
      const res = await fetch(`${app.url}/gallery/thumbnail`);
      expect(res.status).toBe(400);
    } finally { await app.close(); }
  });

  it('400 on traversal attempt', async () => {
    const app = await startApp();
    try {
      const res = await fetch(
        `${app.url}/gallery/thumbnail?filename=${encodeURIComponent('../etc/passwd')}`,
      );
      expect(res.status).toBe(400);
    } finally { await app.close(); }
  });

  it('generates + serves a cached webp on first request, uses cache on second', async () => {
    const app = await startApp();
    try {
      const res = await fetch(
        `${app.url}/gallery/thumbnail?filename=demo.mp4&type=output&w=320`,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/webp');
      expect(res.headers.get('cache-control')).toBe('public, max-age=31536000');
      const bytes = await res.arrayBuffer();
      expect(bytes.byteLength).toBeGreaterThan(0);

      // ffmpeg was invoked with the expected positional args.
      expect(spawnCalls.length).toBe(1);
      expect(spawnCalls[0].cmd).toBe('ffmpeg');
      const args = spawnCalls[0].args;
      expect(args).toContain('-ss');
      expect(args).toContain('-vframes');
      expect(args).toContain('-vf');
      expect(args.some(a => a === 'scale=320:-1')).toBe(true);

      // Second call must read from cache — no new spawn.
      const cacheDir = path.join(tmpRoot, '.cache', 'video-thumbs');
      const cached = fs.readdirSync(cacheDir).filter(f => f.endsWith('.webp'));
      expect(cached.length).toBe(1);

      const res2 = await fetch(
        `${app.url}/gallery/thumbnail?filename=demo.mp4&type=output&w=320`,
      );
      expect(res2.status).toBe(200);
      expect(spawnCalls.length).toBe(1);
    } finally { await app.close(); }
  });

  it('400 on width out of bounds', async () => {
    const app = await startApp();
    try {
      const res = await fetch(
        `${app.url}/gallery/thumbnail?filename=demo.mp4&type=output&w=10`,
      );
      expect(res.status).toBe(400);
    } finally { await app.close(); }
  });
});
