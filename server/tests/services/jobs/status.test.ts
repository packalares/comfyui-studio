// Tests for services/jobs/status.ts — getJobStatus

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useFreshDb } from '../../lib/db/_helpers.js';
import * as repo from '../../../src/lib/db/gallery.repo.js';

// We mock the comfyui api module to avoid real network calls.
const mockGetQueuePromptIds = vi.fn<[], Promise<Set<string>>>();
const mockGetHistoryForPrompt = vi.fn<[string], Promise<Record<string, unknown> | null>>();

vi.mock('../../../src/services/comfyui/api.js', () => ({
  getQueuePromptIds: () => mockGetQueuePromptIds(),
  getHistoryForPrompt: (id: string) => mockGetHistoryForPrompt(id),
}));

// Import after mocking.
const { getJobStatus } = await import('../../../src/services/jobs/status.js');

useFreshDb();

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('getJobStatus: bridge-live (queue)', () => {
  it('returns running when promptId is in the active queue', async () => {
    mockGetQueuePromptIds.mockResolvedValue(new Set(['active-pid']));
    mockGetHistoryForPrompt.mockResolvedValue(null);
    const status = await getJobStatus('active-pid');
    expect(status).not.toBeNull();
    expect(status?.status).toBe('running');
    expect(status?.id).toBe('active-pid');
  });
});

describe('getJobStatus: gallery-only (terminal)', () => {
  it('returns success + items when gallery has rows for the promptId', async () => {
    mockGetQueuePromptIds.mockResolvedValue(new Set()); // not in queue
    mockGetHistoryForPrompt.mockResolvedValue({
      status: { messages: [] }, // success — no error messages
    });
    repo.insert({
      id: 'gallery-item-1',
      filename: 'output.png',
      subfolder: '',
      type: 'output',
      mediaType: 'image',
      url: '/api/view?filename=output.png',
      promptId: 'done-pid',
      createdAt: 1000,
    });
    const status = await getJobStatus('done-pid');
    expect(status?.status).toBe('success');
    expect(status?.result?.items).toHaveLength(1);
    expect(status?.result?.items[0].filename).toBe('output.png');
  });

  it('returns failed when history has execution_error message', async () => {
    mockGetQueuePromptIds.mockResolvedValue(new Set());
    mockGetHistoryForPrompt.mockResolvedValue({
      status: { messages: [['execution_error', { exception_message: 'OOM' }]] },
    });
    repo.insert({
      id: 'err-item-1',
      filename: 'output.mp4',
      subfolder: '',
      type: 'output',
      mediaType: 'video',
      url: '/api/view?filename=output.mp4',
      promptId: 'failed-pid',
      createdAt: 2000,
    });
    const status = await getJobStatus('failed-pid');
    expect(status?.status).toBe('failed');
  });
});

describe('getJobStatus: history-only (cold)', () => {
  it('returns success when history entry exists but no gallery row yet', async () => {
    mockGetQueuePromptIds.mockResolvedValue(new Set());
    mockGetHistoryForPrompt.mockResolvedValue({
      status: { messages: [] },
      outputs: {},
    });
    const status = await getJobStatus('history-only-pid');
    expect(status?.status).toBe('success');
    expect(status?.result).toBeUndefined(); // no gallery rows
  });

  it('returns failed when history has error and no gallery row', async () => {
    mockGetQueuePromptIds.mockResolvedValue(new Set());
    mockGetHistoryForPrompt.mockResolvedValue({
      status: { messages: [['execution_error', { exception_message: 'CUDA OOM' }]] },
    });
    const status = await getJobStatus('history-error-pid');
    expect(status?.status).toBe('failed');
    expect(status?.error?.message).toBe('CUDA OOM');
  });
});

describe('getJobStatus: unknown', () => {
  it('returns null when ComfyUI reachable but promptId not in queue or history', async () => {
    mockGetQueuePromptIds.mockResolvedValue(new Set());
    mockGetHistoryForPrompt.mockResolvedValue(null);
    const status = await getJobStatus('unknown-pid');
    expect(status).toBeNull();
  });

  it('returns null when ComfyUI unreachable and no gallery row', async () => {
    mockGetQueuePromptIds.mockRejectedValue(new Error('ECONNREFUSED'));
    mockGetHistoryForPrompt.mockRejectedValue(new Error('ECONNREFUSED'));
    const status = await getJobStatus('no-comfy-pid');
    expect(status).toBeNull();
  });
});
