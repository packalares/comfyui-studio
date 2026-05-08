// Unit tests for the chat-attachments service: file persistence to disk +
// metadata rows in `chat_attachments`, plus the cascading file cleanup
// helpers that run before a message / conversation row is deleted.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

let tmpDir = '';

// Mock `paths.runtimeStateDir` so attachmentDir() resolves under tmpDir.
// `paths.sqlitePath` is left to the real getter which honors
// `STUDIO_SQLITE_PATH` from env.
vi.mock('../../../src/config/paths.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/config/paths.js')>();
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

import {
  extractAndPersistAttachments,
  persistAttachmentBytes,
  deleteMessageAttachmentFiles,
  deleteConversationAttachmentFiles,
  deleteAllAttachmentFiles,
  hydrateParts,
  buildAttachmentMap,
  attachmentDir,
} from '../../../src/services/chat/attachments.js';
import * as repo from '../../../src/lib/db/chat.repo.js';
import { resetForTests } from '../../../src/lib/db/connection.js';

// 1×1 red PNG.
const RED_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI6QAAAABJRU5ErkJggg==';
const RED_PNG_DATA_URL = `data:image/png;base64,${RED_PNG_B64}`;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-test-'));
  process.env.STUDIO_SQLITE_PATH = path.join(tmpDir, 'studio.db');
  resetForTests();
});

afterEach(() => {
  resetForTests();
  delete process.env.STUDIO_SQLITE_PATH;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  tmpDir = '';
});

function seedConversationAndMessage(convId = 'c1', msgId = 'm1'): void {
  const now = Date.now();
  repo.createConversation({
    id: convId, title: 't', model: 'm', created_at: now, updated_at: now,
  });
  repo.appendMessage({
    id: msgId, conversation_id: convId, role: 'user', parts: '[]', created_at: now,
  });
}

describe('extractAndPersistAttachments', () => {
  it('writes file to disk + inserts row + rewrites part to attachmentId ref', () => {
    seedConversationAndMessage();
    const parts = [{ type: 'file', mediaType: 'image/png', url: RED_PNG_DATA_URL, name: 'red.png' }];

    const { rewrittenParts, attachmentIds } = extractAndPersistAttachments('c1', 'm1', parts);

    expect(attachmentIds).toHaveLength(1);
    const id = attachmentIds[0];

    // Part is now a reference, not an inline data URL.
    expect(rewrittenParts[0]).toEqual({ type: 'file', attachmentId: id, name: 'red.png' });

    // Row exists with all metadata populated.
    const row = repo.getAttachment(id);
    expect(row).not.toBeNull();
    expect(row?.conversation_id).toBe('c1');
    expect(row?.message_id).toBe('m1');
    expect(row?.mime_type).toBe('image/png');
    expect(row?.ext).toBe('png');
    expect(row?.source).toBe('user');
    expect(row?.size_bytes).toBeGreaterThan(0);
    expect(row?.content_hash).toMatch(/^[a-f0-9]{64}$/);

    // File on disk at <attachmentDir>/<id>.png.
    const onDisk = path.join(tmpDir, 'chat-attachments', `${id}.png`);
    expect(fs.existsSync(onDisk)).toBe(true);
  });

  it('leaves non-data URL parts unchanged', () => {
    seedConversationAndMessage();
    const parts = [
      { type: 'file', mediaType: 'image/png', url: '/api/chat/attachments/foo.png' },
    ];
    const { rewrittenParts, attachmentIds } = extractAndPersistAttachments('c1', 'm1', parts);
    expect(attachmentIds).toHaveLength(0);
    expect((rewrittenParts[0] as { url: string }).url).toBe('/api/chat/attachments/foo.png');
  });

  it('leaves text parts unchanged', () => {
    seedConversationAndMessage();
    const parts = [{ type: 'text', text: 'hello' }];
    const { rewrittenParts, attachmentIds } = extractAndPersistAttachments('c1', 'm1', parts);
    expect(attachmentIds).toHaveLength(0);
    expect(rewrittenParts[0]).toEqual({ type: 'text', text: 'hello' });
  });
});

describe('persistAttachmentBytes (tool path)', () => {
  it('persists buffer + inserts row tagged source=tool', () => {
    seedConversationAndMessage('c2', 'm2');
    const buf = Buffer.from('hello world', 'utf8');
    const { id, ext, url, size } = persistAttachmentBytes(buf, {
      conversationId: 'c2',
      messageId: 'm2',
      mimeType: 'application/pdf',
      source: 'tool',
    });
    expect(ext).toBe('pdf');
    expect(url).toBe(`/api/chat/attachments/${id}.pdf`);
    expect(size).toBe(buf.byteLength);

    const row = repo.getAttachment(id);
    expect(row?.source).toBe('tool');
    expect(row?.message_id).toBe('m2');

    const onDisk = path.join(tmpDir, 'chat-attachments', `${id}.pdf`);
    expect(fs.readFileSync(onDisk).equals(buf)).toBe(true);
  });
});

describe('hydrateParts', () => {
  it('replaces { type:file, attachmentId } with { url, mediaType, name, size }', () => {
    seedConversationAndMessage();
    const { rewrittenParts, attachmentIds } = extractAndPersistAttachments(
      'c1', 'm1',
      [{ type: 'file', mediaType: 'image/png', url: RED_PNG_DATA_URL, name: 'red.png' }],
    );
    const id = attachmentIds[0];
    const map = buildAttachmentMap([repo.getAttachment(id)!]);
    const hydrated = hydrateParts(rewrittenParts, map) as Array<Record<string, unknown>>;

    expect(hydrated[0].type).toBe('file');
    expect(hydrated[0].url).toBe(`/api/chat/attachments/${id}.png`);
    expect(hydrated[0].mediaType).toBe('image/png');
    expect(hydrated[0].name).toBe('red.png');
    expect(typeof hydrated[0].size).toBe('number');
  });

  it('returns a stub when the attachment row was deleted', () => {
    const hydrated = hydrateParts(
      [{ type: 'file', attachmentId: 'gone' }],
      new Map(),
    ) as Array<Record<string, unknown>>;
    expect(hydrated[0].type).toBe('file');
    expect(hydrated[0].name).toBe('missing');
  });
});

describe('delete-time file unlink', () => {
  it('deleteMessageAttachmentFiles removes files for one message only', () => {
    seedConversationAndMessage('c1', 'm1');
    repo.appendMessage({
      id: 'm2', conversation_id: 'c1', role: 'user', parts: '[]', created_at: Date.now(),
    });
    extractAndPersistAttachments('c1', 'm1',
      [{ type: 'file', mediaType: 'image/png', url: RED_PNG_DATA_URL }]);
    extractAndPersistAttachments('c1', 'm2',
      [{ type: 'file', mediaType: 'image/png', url: RED_PNG_DATA_URL }]);

    const m1Files = repo.listAttachmentsForMessage('m1');
    const m2Files = repo.listAttachmentsForMessage('m2');
    expect(m1Files).toHaveLength(1);
    expect(m2Files).toHaveLength(1);

    deleteMessageAttachmentFiles('m1');

    expect(fs.existsSync(path.join(attachmentDir(), `${m1Files[0].id}.png`))).toBe(false);
    expect(fs.existsSync(path.join(attachmentDir(), `${m2Files[0].id}.png`))).toBe(true);
  });

  it('deleteConversationAttachmentFiles removes every file in the conv', () => {
    seedConversationAndMessage('c1', 'm1');
    seedConversationAndMessage('c2', 'm2');
    extractAndPersistAttachments('c1', 'm1',
      [{ type: 'file', mediaType: 'image/png', url: RED_PNG_DATA_URL }]);
    extractAndPersistAttachments('c2', 'm2',
      [{ type: 'file', mediaType: 'image/png', url: RED_PNG_DATA_URL }]);

    const c1Files = repo.listAttachmentsForConversation('c1');
    const c2Files = repo.listAttachmentsForConversation('c2');

    deleteConversationAttachmentFiles('c1');

    expect(fs.existsSync(path.join(attachmentDir(), `${c1Files[0].id}.png`))).toBe(false);
    expect(fs.existsSync(path.join(attachmentDir(), `${c2Files[0].id}.png`))).toBe(true);
  });

  it('deleteAllAttachmentFiles wipes everything', () => {
    seedConversationAndMessage('c1', 'm1');
    seedConversationAndMessage('c2', 'm2');
    extractAndPersistAttachments('c1', 'm1',
      [{ type: 'file', mediaType: 'image/png', url: RED_PNG_DATA_URL }]);
    extractAndPersistAttachments('c2', 'm2',
      [{ type: 'file', mediaType: 'image/png', url: RED_PNG_DATA_URL }]);

    deleteAllAttachmentFiles();

    const dirEntries = fs.readdirSync(attachmentDir());
    expect(dirEntries).toHaveLength(0);
  });

  it('FK cascade removes chat_attachments rows when message is deleted', () => {
    seedConversationAndMessage();
    extractAndPersistAttachments('c1', 'm1',
      [{ type: 'file', mediaType: 'image/png', url: RED_PNG_DATA_URL }]);
    expect(repo.listAttachmentsForMessage('m1')).toHaveLength(1);

    repo.deleteMessage('c1', 'm1');
    expect(repo.listAttachmentsForMessage('m1')).toHaveLength(0);
  });

  it('FK cascade removes chat_attachments rows when conversation is deleted', () => {
    seedConversationAndMessage();
    extractAndPersistAttachments('c1', 'm1',
      [{ type: 'file', mediaType: 'image/png', url: RED_PNG_DATA_URL }]);

    repo.deleteConversation('c1');
    expect(repo.listAttachmentsForConversation('c1')).toHaveLength(0);
  });
});
