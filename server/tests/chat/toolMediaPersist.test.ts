import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpRoot: string;
let savedConfigRoot: string | undefined;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-media-test-'));
  savedConfigRoot = process.env.STUDIO_CONFIG_ROOT;
  process.env.STUDIO_CONFIG_ROOT = tmpRoot;
  vi.resetModules();
});

afterEach(() => {
  if (savedConfigRoot !== undefined) process.env.STUDIO_CONFIG_ROOT = savedConfigRoot;
  else delete process.env.STUDIO_CONFIG_ROOT;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const PNG_MAGIC_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=';

async function loadModule() {
  const mod = await import('../../src/services/chat/toolMediaPersist.js');
  const attach = await import('../../src/services/chat/attachments.js');
  return { ...mod, attachmentDir: attach.attachmentDir };
}

describe('persistInlineMediaInResult', () => {
  it('passes through results that have no content array', async () => {
    const { persistInlineMediaInResult } = await loadModule();
    expect(persistInlineMediaInResult({ ok: true })).toEqual({ ok: true });
    expect(persistInlineMediaInResult('plain string')).toBe('plain string');
    expect(persistInlineMediaInResult(null)).toBe(null);
  });

  it('rewrites inline image content to an attachments URL and writes the file', async () => {
    const { persistInlineMediaInResult, attachmentDir } = await loadModule();
    const result = persistInlineMediaInResult(
      {
        content: [
          { type: 'image', data: PNG_MAGIC_B64, mimeType: 'image/png' },
        ],
      },
      { toolCallId: 'call_test_1' },
    );
    const content = (result as { content: Array<{ type: string; text: string }> }).content;
    expect(content[0].type).toBe('text');
    expect(content[0].text).toMatch(/^Image saved and rendered to the user → \/api\/chat\/attachments\/call_test_1-[a-f0-9]{12}\.png\. /);
    expect(content[0].text).toContain('do NOT call the tool again');

    // The file actually landed on disk with PNG magic header.
    const m = content[0].text.match(/\/api\/chat\/attachments\/(.+)$/)!;
    const filename = m[1];
    const full = path.join(attachmentDir(), filename);
    expect(fs.existsSync(full)).toBe(true);
    const buf = fs.readFileSync(full);
    expect(buf[0]).toBe(0x89);
    expect(buf[1]).toBe(0x50);   // 'P'
    expect(buf[2]).toBe(0x4E);   // 'N'
    expect(buf[3]).toBe(0x47);   // 'G'
  });

  it('rewrites a resource entry with nested blob (PDF-style)', async () => {
    const { persistInlineMediaInResult } = await loadModule();
    const fakeBlob = Buffer.from('%PDF-1.4 fake').toString('base64');
    const result = persistInlineMediaInResult(
      {
        content: [
          { type: 'resource', resource: { blob: fakeBlob, mimeType: 'application/pdf', uri: 'file://x' } },
        ],
      },
      { toolCallId: 'pdf_call' },
    );
    const content = (result as { content: Array<{ type: string; text: string }> }).content;
    expect(content[0].type).toBe('text');
    expect(content[0].text).toMatch(/^PDF saved and rendered to the user → \/api\/chat\/attachments\/pdf_call-[a-f0-9]{12}\.pdf\. /);
  });

  it('preserves non-binary content entries verbatim', async () => {
    const { persistInlineMediaInResult } = await loadModule();
    const result = persistInlineMediaInResult({
      content: [
        { type: 'text', text: 'just text' },
        { type: 'image', data: PNG_MAGIC_B64, mimeType: 'image/png' },
        { type: 'text', text: 'more text' },
      ],
    });
    const content = (result as { content: Array<{ type: string; text: string }> }).content;
    expect(content).toHaveLength(3);
    expect(content[0]).toEqual({ type: 'text', text: 'just text' });
    expect(content[1].type).toBe('text');           // rewritten
    expect(content[1].text).toMatch(/Image saved and rendered/);
    expect(content[2]).toEqual({ type: 'text', text: 'more text' });
  });

  it('returns the original object reference when nothing matched', async () => {
    const { persistInlineMediaInResult } = await loadModule();
    const original = { content: [{ type: 'text', text: 'no media' }] };
    expect(persistInlineMediaInResult(original)).toBe(original);
  });

  it('rewrites crawl4ai-shaped REST-wrapper response (screenshot field inside text JSON)', async () => {
    const { persistInlineMediaInResult } = await loadModule();
    const result = persistInlineMediaInResult(
      {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, screenshot: PNG_MAGIC_B64 }),
          },
        ],
      },
      { toolCallId: 'crawl_call' },
    );
    const content = (result as { content: Array<{ type: string; text: string }> }).content;
    expect(content[0].type).toBe('text');
    expect(content[0].text).toMatch(/^Image saved and rendered to the user → \/api\/chat\/attachments\/crawl_call-[a-f0-9]{12}\.png\. /);
  });

  it('rewrites crawl4ai-shaped pdf field with correct extension', async () => {
    const { persistInlineMediaInResult } = await loadModule();
    const fakePdf = Buffer.from('%PDF-1.4 fake').toString('base64').repeat(5);
    const result = persistInlineMediaInResult(
      {
        content: [
          { type: 'text', text: JSON.stringify({ success: true, pdf: fakePdf }) },
        ],
      },
      { toolCallId: 'pdf_call' },
    );
    const content = (result as { content: Array<{ type: string; text: string }> }).content;
    expect(content[0].text).toMatch(/^PDF saved and rendered to the user → \/api\/chat\/attachments\/pdf_call-[a-f0-9]{12}\.pdf\. /);
  });

  it('does NOT rewrite text-json that has no recognised binary field', async () => {
    const { persistInlineMediaInResult } = await loadModule();
    const result = persistInlineMediaInResult({
      content: [{ type: 'text', text: JSON.stringify({ success: true, html: '<h1>hi</h1>' }) }],
    });
    const content = (result as { content: Array<{ type: string; text: string }> }).content;
    expect(content[0].text).toContain('html');
    expect(content[0].text).not.toContain('saved and rendered');
  });

  it('does NOT misinterpret a path-string as embedded base64', async () => {
    const { persistInlineMediaInResult } = await loadModule();
    const result = persistInlineMediaInResult({
      content: [{ type: 'text', text: JSON.stringify({ success: true, screenshot: '/app/example.png' }) }],
    });
    const content = (result as { content: Array<{ type: string; text: string }> }).content;
    expect(content[0].text).toContain('/app/example.png');
    expect(content[0].text).not.toContain('saved and rendered');
  });

  it('hashes file contents so identical bytes from different toolCallIds dedup at SHA but not filename', async () => {
    const { persistInlineMediaInResult, attachmentDir } = await loadModule();
    const a = persistInlineMediaInResult(
      { content: [{ type: 'image', data: PNG_MAGIC_B64, mimeType: 'image/png' }] },
      { toolCallId: 'A' },
    );
    const b = persistInlineMediaInResult(
      { content: [{ type: 'image', data: PNG_MAGIC_B64, mimeType: 'image/png' }] },
      { toolCallId: 'B' },
    );
    const aFile = (a as { content: Array<{ text: string }> }).content[0].text.match(/attachments\/(.+)$/)![1];
    const bFile = (b as { content: Array<{ text: string }> }).content[0].text.match(/attachments\/(.+)$/)![1];
    expect(aFile.startsWith('A-')).toBe(true);
    expect(bFile.startsWith('B-')).toBe(true);
    // Same content hash suffix.
    expect(aFile.replace(/^A-/, '')).toBe(bFile.replace(/^B-/, ''));
    // Both files exist.
    expect(fs.existsSync(path.join(attachmentDir(), aFile))).toBe(true);
    expect(fs.existsSync(path.join(attachmentDir(), bFile))).toBe(true);
  });
});
