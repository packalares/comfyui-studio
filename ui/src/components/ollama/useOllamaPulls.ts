// Subscribes to the chat WS pull-lifecycle events and exposes:
//   - `pulls`         the name→state map every Library / HF card reads
//   - `handlePull`    POST /chat/models/pull + optimistic placeholder
//   - `handleCancel`  POST /chat/models/pull/cancel (WS error-event clears
//                     the entry, no optimistic local removal needed)
//
// Pulled out of OllamaModelsPanel to keep that file under the 250-line cap.
// The hook takes `onPullSuccess` so the panel can refresh its installed
// list when a pull completes (driving the "Installed" badge).

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../services/comfyui';
import { chatEvents } from '../../services/chatEvents';
import type { PullState } from './shared';

export function useOllamaPulls(onPullSuccess: () => void) {
  const [pulls, setPulls] = useState<Record<string, PullState>>({});

  useEffect(() => {
    const offProgress = chatEvents.onPullProgress((p) => {
      setPulls(prev => ({
        ...prev,
        [p.name]: {
          taskId: p.taskId,
          percent: p.percent,
          status: p.status ?? '',
          completed: p.completed,
          total: p.total,
          digest: p.digest,
        },
      }));
    });
    const offDone = chatEvents.onPullDone(({ name }) => {
      setPulls(prev => { const { [name]: _r, ...rest } = prev; return rest; });
      toast.success(`Pulled ${name}`);
      // Caller's refresh flips the HF / Library card to its "Installed"
      // success badge, completing the visual loop.
      onPullSuccess();
    });
    const offError = chatEvents.onPullError(({ name, error }) => {
      setPulls(prev => { const { [name]: _r, ...rest } = prev; return rest; });
      toast.error(`Pull failed: ${name}`, { description: error });
    });
    return () => { offProgress(); offDone(); offError(); };
  }, [onPullSuccess]);

  const handlePull = useCallback(async (name: string) => {
    try {
      await api.chat.pullModel(name);
      setPulls(prev => ({
        ...prev,
        [name]: { taskId: '', percent: 0, status: 'starting' },
      }));
    } catch (err) {
      toast.error('Failed to start pull', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  const handleCancel = useCallback(async (name: string) => {
    try {
      await api.chat.cancelPull(name);
    } catch (err) {
      toast.error('Failed to cancel pull', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  return { pulls, handlePull, handleCancel };
}
