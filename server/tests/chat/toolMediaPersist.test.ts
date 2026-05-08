// Unit tests for `persistInlineMediaInResult`. Each call requires a real
// `(conversationId, messageId)` so the chat_attachments FK is satisfied; the
// helper seeds those rows once per test.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpDir = '';

vi.mock('../../src/config/paths.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/config/paths.js')>();
  return {
    ...actual,
    paths: {
      ...actual.paths,
      get runtimeStateDir() { return tmpDir; },
      get sqlitePath() {
        const override = process.env.STUDIO_SQLITE_PATH;
        return (override && override.length > 0)
          ? override
          : path.join(tmpDir, 'studio.db');
      },
    },
  };
});

import { persistInlineMediaInResult } from '../../src/services/chat/toolMediaPersist.js';
import { attachmentDir } from '../../src/services/chat/attachments.js';
import * as repo from '../../src/lib/db/chat.repo.js';
import { resetForTests } from '../../src/lib/db/connection.js';

const PNG_MAGIC_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-media-test-'));
  process.env.STUDIO_SQLITE_PATH = path.join(tmpDir, 'studio.db');
  resetForTests();
  // Seed conversation + message so chat_attachments FK is satisfied.
  const now = Date.now();
  repo.createConversation({ id: 'c1', title: 't', model: 'm', created_at: now, updated_at: now });
  repo.appendMessage({ id: 'm1', conversation_id: 'c1', role: 'assistant', parts: '[]', created_at: now });
});

afterEach(() => {
  resetForTests();
  delete process.env.STUDIO_SQLITE_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = '';
});

const ctx = { conversationId: 'c1', messageId: 'm1' };

const URL_RX = /\/api\/chat\/attachments\/([A-Za-z0-9_-]+)\.([A-Za-z0-9]+)/;

describe('persistInlineMediaInResult', () => {
  it('passes through results that have no content array', () => {
    expect(persistInlineMediaInResult({ ok: true }, ctx)).toEqual({ ok: true });
    expect(persistInlineMediaInResult('plain string', ctx)).toBe('plain string');
    expect(persistInlineMediaInResult(null, ctx)).toBe(null);
  });

  it('rewrites inline image content to an attachments URL and writes the file', () => {
    const result = persistInlineMediaInResult(
      { content: [{ type: 'image', data: PNG_MAGIC_B64, mimeType: 'image/png' }] },
      ctx,
    );
    const content = (result as { content: Array<{ type: string; text: string }> }).content;
    expect(content[0].type).toBe('text');
    expect(content[0].text).toMatch(/^Image saved and rendered to the user → /);
    expect(content[0].text).toContain('do NOT call the tool again');

    const m = URL_RX.exec(content[0].text);
    expect(m).not.toBeNull();
    const filename = `${m![1]}.${m![2]}`;
    const full = path.join(attachmentDir(), filename);
    expect(fs.existsSync(full)).toBe(true);
    const buf = fs.readFileSync(full);
    expect(buf[0]).toBe(0x89);
    expect(buf[1]).toBe(0x50);
    expect(buf[2]).toBe(0x4E);
    expect(buf[3]).toBe(0x47);

    // Row exists in chat_attachments and is owned by m1.
    const row = repo.getAttachment(m![1]);
    expect(row).not.toBeNull();
    expect(row?.message_id).toBe('m1');
    expect(row?.source).toBe('tool');
    expect(row?.ext).toBe('png');
  });

  it('rewrites a resource entry with nested blob (PDF-style)', () => {
    const fakeBlob = Buffer.from('%PDF-1.4 fake').toString('base64');
    const result = persistInlineMediaInResult(
      { content: [{ type: 'resource', resource: { blob: fakeBlob, mimeType: 'application/pdf', uri: 'file://x' } }] },
      ctx,
    );
    const content = (result as { content: Array<{ type: string; text: string }> }).content;
    expect(content[0].text).toMatch(/^PDF saved and rendered to the user → /);
    const m = URL_RX.exec(content[0].text)!;
    expect(m[2]).toBe('pdf');
  });

  it('preserves non-binary content entries verbatim', () => {
    const result = persistInlineMediaInResult({
      content: [
        { type: 'text', text: 'just text' },
        { type: 'image', data: PNG_MAGIC_B64, mimeType: 'image/png' },
        { type: 'text', text: 'more text' },
      ],
    }, ctx);
    const content = (result as { content: Array<{ type: string; text: string }> }).content;
    expect(content).toHaveLength(3);
    expect(content[0]).toEqual({ type: 'text', text: 'just text' });
    expect(content[1].text).toMatch(/Image saved and rendered/);
    expect(content[2]).toEqual({ type: 'text', text: 'more text' });
  });

  it('returns the original object reference when nothing matched', () => {
    const original = { content: [{ type: 'text', text: 'no media' }] };
    expect(persistInlineMediaInResult(original, ctx)).toBe(original);
  });

  it('rewrites crawl4ai-shaped REST-wrapper response (screenshot field inside text JSON)', () => {
    // The detector skips strings shorter than 100 chars to avoid promoting
    // path-strings; pad the base64 by repeating it so it crosses the threshold.
    const longerPng = PNG_MAGIC_B64.repeat(2);
    const result = persistInlineMediaInResult({
      content: [{ type: 'text', text: JSON.stringify({ success: true, screenshot: longerPng }) }],
    }, ctx);
    const content = (result as { content: Array<{ type: string; text: string }> }).content;
    expect(content[0].text).toMatch(/^Image saved and rendered to the user → /);
    expect(URL_RX.exec(content[0].text)![2]).toBe('png');
  });

  it('rewrites crawl4ai-shaped pdf field with correct extension', () => {
    const fakePdf = Buffer.from('%PDF-1.4 fake').toString('base64').repeat(5);
    const result = persistInlineMediaInResult({
      content: [{ type: 'text', text: JSON.stringify({ success: true, pdf: fakePdf }) }],
    }, ctx);
    const content = (result as { content: Array<{ type: string; text: string }> }).content;
    expect(content[0].text).toMatch(/^PDF saved and rendered to the user → /);
    expect(URL_RX.exec(content[0].text)![2]).toBe('pdf');
  });

  it('does NOT rewrite text-json that has no recognised binary field', () => {
    const result = persistInlineMediaInResult({
      content: [{ type: 'text', text: JSON.stringify({ success: true, html: '<h1>hi</h1>' }) }],
    }, ctx);
    const content = (result as { content: Array<{ type: string; text: string }> }).content;
    expect(content[0].text).toContain('html');
    expect(content[0].text).not.toContain('saved and rendered');
  });

  it('does NOT misinterpret a path-string as embedded base64', () => {
    const result = persistInlineMediaInResult({
      content: [{ type: 'text', text: JSON.stringify({ success: true, screenshot: '/app/example.png' }) }],
    }, ctx);
    const content = (result as { content: Array<{ type: string; text: string }> }).content;
    expect(content[0].text).toContain('/app/example.png');
    expect(content[0].text).not.toContain('saved and rendered');
  });

  it('two calls with identical bytes get distinct attachment rows + files (no dedup)', () => {
    const a = persistInlineMediaInResult(
      { content: [{ type: 'image', data: PNG_MAGIC_B64, mimeType: 'image/png' }] },
      ctx,
    );
    const b = persistInlineMediaInResult(
      { content: [{ type: 'image', data: PNG_MAGIC_B64, mimeType: 'image/png' }] },
      ctx,
    );
    const aMatch = URL_RX.exec((a as { content: [{ text: string }] }).content[0].text)!;
    const bMatch = URL_RX.exec((b as { content: [{ text: string }] }).content[0].text)!;
    expect(aMatch[1]).not.toBe(bMatch[1]);
    expect(fs.existsSync(path.join(attachmentDir(), `${aMatch[1]}.${aMatch[2]}`))).toBe(true);
    expect(fs.existsSync(path.join(attachmentDir(), `${bMatch[1]}.${bMatch[2]}`))).toBe(true);
    // Both rows exist with the same content_hash (sha of the bytes).
    const ra = repo.getAttachment(aMatch[1])!;
    const rb = repo.getAttachment(bMatch[1])!;
    expect(ra.content_hash).toBe(rb.content_hash);
  });
});
