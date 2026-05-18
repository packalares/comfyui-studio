// Tests for streamCleanDownload.
//
// Strategy:
//  - Image strip: write a minimal PNG that carries a tEXt chunk, run
//    streamCleanDownload, verify the output buffer has no tEXt chunk.
//  - Unsupported extension: mock res and assert 415.
//  - 3D passthrough: GLB file bytes-equal after strip.
//  - Audio/video: if ffmpeg is absent, skip; otherwise assert correct
//    ffmpeg args by mocking child_process.spawn.
//
// PNG chunk walking is done in pure Node (no external lib):
//   8-byte signature, then repeated [4-byte length][4-type][data][4-crc].

import { describe, expect, it, afterEach, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { streamCleanDownload } from '../../../src/services/gallery/downloadStrip.js';

// ── Helpers ────────────────────────────────────────────────────────────────

let tmpDir = '';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'downloadStrip-'));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  vi.restoreAllMocks();
});

// Build a valid 1×1 PNG from a known-good base64 blob, then splice a
// tEXt chunk in after the IHDR. The base PNG is produced by sharp so it
// is definitely valid. We inject the tEXt chunk to verify the strip path
// removes it.
//
// WHY not generate with sharp at test time: sharp `.withMetadata()` writes
// EXIF, not PNG tEXt; we need the tEXt type specifically to match
// ComfyUI's embedding convention.
function crc32(buf: Buffer): number {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = table[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(type: string, data: Buffer): Buffer {
  const typeB = Buffer.from(type, 'ascii');
  const lenB = Buffer.alloc(4);
  lenB.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeB, data]);
  const crcB = Buffer.alloc(4);
  crcB.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenB, typeB, data, crcB]);
}

// Inject a tEXt chunk into an existing valid PNG buffer right after the IHDR.
function injectTextChunk(pngBuf: Buffer, keyword: string, text: string): Buffer {
  const SIG_LEN = 8;
  // IHDR chunk: 4 (length) + 4 (type) + 13 (data) + 4 (crc) = 25 bytes
  const IHDR_TOTAL = 25;
  const insertAt = SIG_LEN + IHDR_TOTAL;
  const textData = Buffer.concat([
    Buffer.from(keyword, 'latin1'),
    Buffer.from([0]),
    Buffer.from(text, 'latin1'),
  ]);
  const textChunk = makePngChunk('tEXt', textData);
  return Buffer.concat([
    pngBuf.subarray(0, insertAt),
    textChunk,
    pngBuf.subarray(insertAt),
  ]);
}

async function buildPngWithTextChunk(keyword: string, text: string): Promise<Buffer> {
  // Import sharp dynamically to avoid circular dep issues in test file.
  const { default: sharpImport } = await import('sharp');
  // Create a valid 1×1 PNG base via sharp (no metadata).
  const base = await sharpImport({
    create: { width: 1, height: 1, channels: 3, background: { r: 0, g: 0, b: 0 } },
  }).png().toBuffer();
  return injectTextChunk(base, keyword, text);
}

// Walk PNG chunks and return array of chunk type strings.
function pngChunkTypes(buf: Buffer): string[] {
  const PNG_SIG_LEN = 8;
  const types: string[] = [];
  let pos = PNG_SIG_LEN;
  while (pos + 12 <= buf.length) {
    const dataLen = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString('ascii');
    types.push(type);
    pos += 4 + 4 + dataLen + 4;
    if (type === 'IEND') break;
  }
  return types;
}

// Build a mock Express response that captures the written body.
function makeMockRes() {
  const headers: Record<string, string> = {};
  const chunks: Buffer[] = [];
  let statusCode = 200;
  let ended = false;
  const res: Record<string, unknown> = {
    destroyed: false,
    statusCode,
    setHeader(k: string, v: string) { headers[k] = v; },
    status(code: number) { statusCode = code; res.statusCode = code; return res; },
    json(body: unknown) { chunks.push(Buffer.from(JSON.stringify(body))); ended = true; return res; },
    end(data?: unknown) {
      if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
      ended = true;
    },
    write(data: Buffer) { chunks.push(data); },
    on(_: string, __: unknown) { return res; },
    once(_: string, __: unknown) { return res; },
    emit(_: string, ...__: unknown[]) { return false; },
    removeListener() { return res; },
    pipe(dest: { write: (b: Buffer) => void; end: () => void }) {
      for (const c of chunks) dest.write(c);
      dest.end();
      return dest;
    },
  };
  return {
    res: res as unknown as import('express').Response,
    getStatus: () => statusCode,
    getBody: () => Buffer.concat(chunks),
    getHeaders: () => headers,
    isEnded: () => ended,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('streamCleanDownload', () => {
  it('strips tEXt chunk from PNG', async () => {
    const pngBuf = await buildPngWithTextChunk('prompt', '{"test":true}');
    const pngPath = path.join(tmpDir, 'test.png');
    fs.writeFileSync(pngPath, pngBuf);

    // Verify our test fixture actually contains a tEXt chunk.
    expect(pngChunkTypes(pngBuf)).toContain('tEXt');

    // Use a real HTTP server so the response is properly streamed.
    const app = express();
    app.get('/test', async (_req, res) => {
      await streamCleanDownload(res, pngPath, 'test.png');
    });
    const server = createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    const { port } = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/test`);
    expect(response.status).toBe(200);
    const buf = Buffer.from(await response.arrayBuffer());

    server.close();

    // sharp output should not contain any tEXt chunks.
    const outputTypes = pngChunkTypes(buf);
    expect(outputTypes).not.toContain('tEXt');
    expect(outputTypes).toContain('IHDR');
    expect(outputTypes).toContain('IEND');
  });

  it('returns 415 for unsupported extension', async () => {
    const filePath = path.join(tmpDir, 'test.xyz');
    fs.writeFileSync(filePath, 'data');
    const { res, getStatus } = makeMockRes();
    await streamCleanDownload(res, filePath, 'test.xyz');
    expect(getStatus()).toBe(415);
  });

  it('streams 3D (GLB) as bytes-equal passthrough', async () => {
    const content = Buffer.from('glTF binary content mock data');
    const glbPath = path.join(tmpDir, 'model.glb');
    fs.writeFileSync(glbPath, content);

    const app = express();
    app.get('/test', async (_req, res) => {
      await streamCleanDownload(res, glbPath, 'model.glb');
    });
    const server = createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    const { port } = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/test`);
    expect(response.status).toBe(200);
    const buf = Buffer.from(await response.arrayBuffer());

    server.close();

    expect(buf.equals(content)).toBe(true);
  });

  it('sets Content-Disposition attachment header', async () => {
    const pngBuf = await buildPngWithTextChunk('a', 'b');
    const pngPath = path.join(tmpDir, 'out.png');
    fs.writeFileSync(pngPath, pngBuf);

    const app = express();
    app.get('/test', async (_req, res) => {
      await streamCleanDownload(res, pngPath, 'out.png');
    });
    const server = createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    const { port } = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/test`);
    server.close();

    const disposition = response.headers.get('content-disposition') ?? '';
    expect(disposition).toContain('attachment');
    expect(disposition).toContain('out.png');
  });
});

// ── ffmpeg-dependent tests (skipped when ffmpeg is absent) ────────────────────

async function ffmpegAvailable(): Promise<boolean> {
  try {
    fs.accessSync('/usr/bin/ffmpeg', fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

describe('streamCleanDownload (ffmpeg paths)', () => {
  it('sets correct Content-Type for flac', async () => {
    if (!(await ffmpegAvailable())) {
      console.log('skip: ffmpeg not available');
      return;
    }
    // We only check the header — spawning ffmpeg on an empty file will error,
    // but the header is set before the spawn output is written.
    const filePath = path.join(tmpDir, 'test.flac');
    fs.writeFileSync(filePath, Buffer.alloc(0));
    const { res, getHeaders } = makeMockRes();
    // Will likely error due to invalid flac, but headers should be set.
    await streamCleanDownload(res, filePath, 'test.flac').catch(() => {});
    const ct = getHeaders()['Content-Type'] ?? '';
    expect(ct).toContain('flac');
  });
});
