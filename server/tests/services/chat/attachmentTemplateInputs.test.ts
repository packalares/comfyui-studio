// Unit tests for resolveAttachmentTemplateInputs.
//
// Verifies:
//   - No upload fields → empty result with no errors.
//   - Upload fields present, no attachments → all required fields are unmatched.
//   - Upload fields present, attachments available → correct inputs keyed by
//     field id, uploadFileToComfyUI called with the right path.
//   - Missing messageId (external MCP caller) → empty result, no upload attempt.

import { describe, expect, it, vi, beforeEach } from 'vitest';

// --- mocks -------------------------------------------------------------------

vi.mock('../../../src/services/templates/index.js', () => ({
  getTemplate: vi.fn(),
}));

vi.mock('../../../src/services/templates/dependencyCheck.js', () => ({
  fetchTemplateWorkflow: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../../src/services/workflow/index.js', () => ({
  getObjectInfo: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../../src/services/templates/templates.formInputs.js', () => ({
  generateFormInputs: vi.fn(),
}));

vi.mock('../../../src/lib/db/chat.repo.js', () => ({
  listAttachmentsForMessage: vi.fn(),
}));

vi.mock('../../../src/services/chat/attachments.js', () => ({
  attachmentDir: vi.fn().mockReturnValue('/tmp/attachments'),
}));

vi.mock('../../../src/services/comfyui/upload.js', () => ({
  uploadFileToComfyUI: vi.fn(),
  comfyFilenameFromResult: vi.fn((r: { name: string }) => r.name),
}));

// Silence paths config (not used directly but imported transitively in some
// modules; avoid ENOENT during import resolution in test env).
vi.mock('../../../src/config/paths.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/config/paths.js')>();
  return { ...actual };
});

import { resolveAttachmentTemplateInputs } from '../../../src/services/chat/attachmentTemplateInputs.js';
import * as templatesIndex from '../../../src/services/templates/index.js';
import * as formInputsMod from '../../../src/services/templates/templates.formInputs.js';
import * as chatRepo from '../../../src/lib/db/chat.repo.js';
import * as uploadMod from '../../../src/services/comfyui/upload.js';

const mockGetTemplate = vi.mocked(templatesIndex.getTemplate);
const mockGenerateFormInputs = vi.mocked(formInputsMod.generateFormInputs);
const mockListAttachments = vi.mocked(chatRepo.listAttachmentsForMessage);
const mockUploadFile = vi.mocked(uploadMod.uploadFileToComfyUI);

// Minimal TemplateData stub.
const STUB_TEMPLATE = {
  name: 'test-tpl', title: 'Test', description: '',
  mediaType: 'image', tags: [], models: [],
  category: 'image', io: { inputs: [], outputs: [] }, thumbnail: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetTemplate.mockReturnValue(STUB_TEMPLATE as ReturnType<typeof mockGetTemplate>);
  mockUploadFile.mockResolvedValue({ name: 'uploaded.png', subfolder: '', type: 'input' });
});

describe('resolveAttachmentTemplateInputs', () => {
  it('returns empty result when template has no upload fields', async () => {
    mockGenerateFormInputs.mockReturnValue([
      { id: 'prompt', label: 'Prompt', type: 'textarea', required: true },
    ] as ReturnType<typeof mockGenerateFormInputs>);

    const result = await resolveAttachmentTemplateInputs({
      templateName: 'test-tpl',
      messageId: 'msg-1',
    });

    expect(result.filledInputs).toEqual({});
    expect(result.unmatchedRequiredFields).toEqual([]);
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  it('returns all required upload fields as unmatched when message has no attachments', async () => {
    mockGenerateFormInputs.mockReturnValue([
      { id: 'image_0', label: 'Source Image', type: 'image', required: true },
    ] as ReturnType<typeof mockGenerateFormInputs>);
    mockListAttachments.mockReturnValue([]);

    const result = await resolveAttachmentTemplateInputs({
      templateName: 'test-tpl',
      messageId: 'msg-1',
    });

    expect(result.filledInputs).toEqual({});
    expect(result.unmatchedRequiredFields).toEqual(['Source Image']);
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  it('fills image field from matching image attachment', async () => {
    mockGenerateFormInputs.mockReturnValue([
      { id: 'image_0', label: 'Source Image', type: 'image', required: true },
    ] as ReturnType<typeof mockGenerateFormInputs>);
    mockListAttachments.mockReturnValue([
      {
        id: 'att-1', conversation_id: 'conv-1', message_id: 'msg-1',
        display_name: 'photo.png', mime_type: 'image/png', ext: 'png',
        size_bytes: 1024, content_hash: 'abc', source: 'user', created_at: 0,
      },
    ]);

    const result = await resolveAttachmentTemplateInputs({
      templateName: 'test-tpl',
      messageId: 'msg-1',
    });

    expect(mockUploadFile).toHaveBeenCalledWith(
      '/tmp/attachments/att-1.png',
      { mimeType: 'image/png' },
    );
    expect(result.filledInputs).toEqual({ image_0: 'uploaded.png' });
    expect(result.unmatchedRequiredFields).toEqual([]);
  });

  it('returns empty result when messageId is absent (external MCP path)', async () => {
    mockGenerateFormInputs.mockReturnValue([
      { id: 'image_0', label: 'Source Image', type: 'image', required: true },
    ] as ReturnType<typeof mockGenerateFormInputs>);

    const result = await resolveAttachmentTemplateInputs({
      templateName: 'test-tpl',
      // no messageId
    });

    expect(result.filledInputs).toEqual({});
    expect(result.unmatchedRequiredFields).toEqual(['Source Image']);
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  it('does not report optional upload fields as unmatched when no attachment', async () => {
    mockGenerateFormInputs.mockReturnValue([
      { id: 'image_0', label: 'Optional Image', type: 'image', required: false },
    ] as ReturnType<typeof mockGenerateFormInputs>);
    mockListAttachments.mockReturnValue([]);

    const result = await resolveAttachmentTemplateInputs({
      templateName: 'test-tpl',
      messageId: 'msg-1',
    });

    expect(result.filledInputs).toEqual({});
    expect(result.unmatchedRequiredFields).toEqual([]);
  });
});
