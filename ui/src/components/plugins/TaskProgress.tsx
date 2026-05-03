import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import { api } from '../../services/comfyui';
import type { PluginTaskProgress } from '../../types';
import { Spinner } from '../ui/spinner';

interface Props {
  taskId: string;
  /** Called once when the poller observes `completed=true`. */
  onComplete?: (success: boolean) => void;
}

/**
 * Polls `/plugins/progress/:taskId` every 1.5s until completed, then
 * fetches the final log list. Renders a small progress bar and the
 * most recent log line. Falls back to the history `/plugins/logs/...`
 * endpoint once the in-memory task is gone (server keeps history
 * but purges completed tasks from the in-memory map over time).
 */
export default function TaskProgress({ taskId, onComplete }: Props) {
  const [progress, setProgress] = useState<PluginTaskProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const completedRef = useRef(false);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const data = await api.getPluginProgress(taskId);
        if (cancelled) return;
        setProgress(data);
        setError(null);
        if (data.completed && !completedRef.current) {
          completedRef.current = true;
          const success = data.progress >= 100;
          onCompleteRef.current?.(success);
          return;
        }
        if (!data.completed) {
          timer = setTimeout(tick, 1500);
        }
      } catch {
        // Task likely purged from in-memory map; try the persisted logs endpoint
        // so the row still gets a final log view.
        if (cancelled || completedRef.current) return;
        try {
          const logs = await api.getPluginLogs(taskId);
          if (cancelled) return;
          setProgress((prev) => ({
            progress: 100,
            completed: true,
            pluginId: prev?.pluginId ?? '',
            type: prev?.type ?? 'install',
            logs: logs.logs,
            message: prev?.message,
          }));
          completedRef.current = true;
          onCompleteRef.current?.(true);
        } catch (err) {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : 'Failed to poll progress');
          timer = setTimeout(tick, 3000);
        }
      }
    };

    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [taskId]);

  const pct = Math.max(0, Math.min(100, progress?.progress ?? 0));
  const done = progress?.completed ?? false;
  const success = done && pct >= 100;
  const logs = progress?.logs ?? [];
  const lastLog = logs.length > 0 ? logs[logs.length - 1] : progress?.message ?? 'Starting…';

  return (
    <div className="mt-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-1.5 text-[11px] text-slate-600">
          {done ? (
            success ? (
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
            ) : (
              <XCircle className="w-3.5 h-3.5 text-rose-600" />
            )
          ) : (
            <Spinner size="sm" className="text-teal-600" />
          )}
          <span className="font-medium">
            {progress?.type ? progress.type.replace('-', ' ') : 'task'}
          </span>
          <span className="text-slate-400 font-mono">{Math.round(pct)}%</span>
        </div>
      </div>
      <div className="h-1 bg-slate-200 rounded-full overflow-hidden mb-1">
        <div
          className={`h-full rounded-full transition-all duration-300 ${
            done && !success ? 'bg-rose-500' : 'bg-teal-500'
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-[10px] text-slate-500 font-mono truncate" title={lastLog}>
        {error ? error : lastLog}
      </p>
    </div>
  );
}
