// Unit tests for chat attachment extraction + cleanup.
// Patches `paths.runtimeStateDir` so attachmentDir() resolves to a tmpdir.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

let tmpDir = '';

// Mock `paths` so attachmentDir() builds under tmpDir.
vi.mock('../../../src/config/paths.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/config/paths.js')>();
  return {
    paths: {
      ...actual.paths,
      get runtimeStateDir() { return tmpDir; },
    },
  };
});

import {
  extractAndPersistAttachments,
  deleteAttachmentsForMessages,
  attachmentDir,
} from '../../../src/services/chat/attachments.js';

// Inline tiny 1x1 red PNG (base64).
const RED_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI6QAAAABJRU5ErkJggg==';
const RED_PNG_DATA_URL = `data:image/png;base64,${RED_PNG_B64}`;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-test-'));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  tmpDir = '';
});

describe('extractAndPersistAttachments', () => {
  it('writes a file for a data URL part and rewrites the URL', () => {
    const parts = [{ type: 'file', mediaType: 'image/png', url: RED_PNG_DATA_URL, name: 'red.png' }];
    const { rewrittenParts, savedFiles } = extractAndPersistAttachments('msg1', parts);

    expect(savedFiles).toHaveLength(1);
    expect(rewrittenParts[0]).toMatchObject({ type: 'file', mediaType: 'image/png', name: 'red.png' });
    const url = (rewrittenParts[0] as { url: string }).url;
    expect(url).toMatch(/^\/api\/chat\/attachments\/msg1-[a-f0-9]{12}\.png$/);

    const filename = url.split('/').pop()!;
    const onDisk = path.join(attachmentDir(), filename);
    expect(fs.existsSync(onDisk)).toBe(true);
  });

  it('is idempotent — same msgId + same content hash reuses the file', () => {
    const parts = [{ type: 'file', mediaType: 'image/png', url: RED_PNG_DATA_URL }];
    const r1 = extractAndPersistAttachments('msg2', parts);
    const r2 = extractAndPersistAttachments('msg2', parts);
    // Same filename produced both times.
    expect(r1.savedFiles[0]).toBe(r2.savedFiles[0]);
    expect(r1.savedFiles).toHaveLength(1);
    expect(r2.savedFiles).toHaveLength(1);
  });

  it('leaves non-data URL parts unchanged', () => {
    const parts = [
      { type: 'file', mediaType: 'image/png', url: '/api/chat/attachments/existing.png' },
    ];
    const { rewrittenParts, savedFiles } = extractAndPersistAttachments('msg3', parts);
    expect(savedFiles).toHaveLength(0);
    expect((rewrittenParts[0] as { url: string }).url).toBe('/api/chat/attachments/existing.png');
  });

  it('leaves text parts unchanged', () => {
    const parts = [{ type: 'text', text: 'hello' }];
    const { rewrittenParts, savedFiles } = extractAndPersistAttachments('msg4', parts);
    expect(savedFiles).toHaveLength(0);
    expect(rewrittenParts[0]).toEqual({ type: 'text', text: 'hello' });
  });
});

describe('deleteAttachmentsForMessages', () => {
  it('deletes files and returns count', () => {
    const parts = [{ type: 'file', mediaType: 'image/png', url: RED_PNG_DATA_URL }];
    const { rewrittenParts } = extractAndPersistAttachments('msg5', parts);
    const url = (rewrittenParts[0] as { url: string }).url;
    const filename = url.split('/').pop()!;
    const filePath = path.join(attachmentDir(), filename);
    expect(fs.existsSync(filePath)).toBe(true);

    const count = deleteAttachmentsForMessages([rewrittenParts as Record<string, unknown>[]]);
    expect(count).toBe(1);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('is ENOENT-tolerant (best-effort)', () => {
    const parts = [{ type: 'file', url: '/api/chat/attachments/nonexistent.png' }];
    expect(() => deleteAttachmentsForMessages([parts as Record<string, unknown>[]])).not.toThrow();
  });

  it('rejects traversal filenames without throwing', () => {
    const parts = [{ type: 'file', url: '/api/chat/attachments/../../../etc/passwd' }];
    expect(() => deleteAttachmentsForMessages([parts as Record<string, unknown>[]])).not.toThrow();
  });
});
