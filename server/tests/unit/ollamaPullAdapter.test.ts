// Tests for ollamaPullAdapter: NDJSON event translation to UnifiedDownload shape.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  setOllamaPullBus,
  handleOllamaChatEvent,
  __resetForTests,
} from '../../src/services/downloads/ollamaPullAdapter.js';

interface CapturedMsg {
  type: string;
  data: {
    taskId: string;
    status: string;
    progress?: number;
    totalBytes?: number;
    downloadedBytes?: number;
    completed?: boolean;
    error?: string | null;
    source?: string;
    kind?: string;
    modelName?: string;
  };
}

describe('ollamaPullAdapter', () => {
  let emitted: CapturedMsg[] = [];

  beforeEach(() => {
    __resetForTests();
    emitted = [];
    setOllamaPullBus(msg => emitted.push(msg as CapturedMsg));
  });

  it('ignores non-pull events', () => {
    handleOllamaChatEvent('chat:chunk', { msgId: 'x', text: 'hi' });
    expect(emitted).toHaveLength(0);
  });

  it('emits a downloading event on model:pull:progress', () => {
    handleOllamaChatEvent('model:pull:progress', {
      taskId: 'pull_abc123',
      name: 'llama3',
      status: 'pulling manifest',
      percent: 0,
      total: 4000000000,
      completed: 0,
    });
    expect(emitted).toHaveLength(1);
    const msg = emitted[0];
    expect(msg.type).toBe('download');
    expect(msg.data.taskId).toBe('pull_abc123');
    expect(msg.data.status).toBe('downloading');
    expect(msg.data.modelName).toBe('llama3');
    // Extension fields from toDownloadState
    expect((msg.data as { source?: string }).source).toBe('ollama');
    expect((msg.data as { kind?: string }).kind).toBe('llm');
  });

  it('suppresses duplicate progress events with identical bytes/percent', () => {
    const base = {
      taskId: 'pull_dup',
      name: 'llama3',
      status: 'pulling',
      percent: 42,
      total: 1000,
      completed: 420,
    };
    handleOllamaChatEvent('model:pull:progress', base);
    handleOllamaChatEvent('model:pull:progress', base);
    // Second call with identical percent + completed bytes should be suppressed.
    expect(emitted).toHaveLength(1);
  });

  it('emits on progress when percent changes', () => {
    handleOllamaChatEvent('model:pull:progress', {
      taskId: 'pull_delta',
      name: 'mistral',
      status: 'pulling',
      percent: 10,
      total: 1000,
      completed: 100,
    });
    handleOllamaChatEvent('model:pull:progress', {
      taskId: 'pull_delta',
      name: 'mistral',
      status: 'pulling',
      percent: 50,
      total: 1000,
      completed: 500,
    });
    expect(emitted).toHaveLength(2);
    expect(emitted[1].data.progress).toBe(50);
    expect(emitted[1].data.downloadedBytes).toBe(500);
  });

  it('emits a success (completed) event on model:pull:done', () => {
    // Seed progress first so prev state exists.
    handleOllamaChatEvent('model:pull:progress', {
      taskId: 'pull_done',
      name: 'phi3',
      status: 'pulling',
      percent: 99,
      total: 2000,
      completed: 1980,
    });
    handleOllamaChatEvent('model:pull:done', { taskId: 'pull_done', name: 'phi3' });
    const last = emitted[emitted.length - 1];
    expect(last.data.status).toBe('completed');
    expect(last.data.completed).toBe(true);
    expect(last.data.progress).toBe(100);
  });

  it('emits an error event on model:pull:error', () => {
    handleOllamaChatEvent('model:pull:progress', {
      taskId: 'pull_err',
      name: 'gemma',
      status: 'pulling',
      percent: 30,
      total: 500,
      completed: 150,
    });
    handleOllamaChatEvent('model:pull:error', {
      taskId: 'pull_err',
      name: 'gemma',
      error: 'upstream 503',
    });
    const last = emitted[emitted.length - 1];
    expect(last.data.status).toBe('error');
    expect(last.data.error).toBe('upstream 503');
  });

  it('maps UnifiedDownload shape correctly to DownloadState fields', () => {
    handleOllamaChatEvent('model:pull:progress', {
      taskId: 'pull_map',
      name: 'deepseek',
      status: 'pulling',
      percent: 75,
      total: 8000000000,
      completed: 6000000000,
    });
    const msg = emitted[0];
    // DownloadState fields that DownloadsTab reads:
    expect(msg.data.progress).toBe(75);
    expect(msg.data.totalBytes).toBe(8000000000);
    expect(msg.data.downloadedBytes).toBe(6000000000);
    expect(msg.data.taskId).toBe('pull_map');
    expect(msg.data.modelName).toBe('deepseek');
  });
});
