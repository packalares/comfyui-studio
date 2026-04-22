// Persistent bottom-right indicator that shows ComfyUI activity app-wide.
//
// Visible only when:
//   - ComfyUI's queue has anything running or pending, OR
//   - we've observed an active promptId via WS (`progress`, `executing`,
//     `execution_start`), OR
//   - we're still receiving `progress` messages.
// Slides up from the bottom edge on show, slides back down on hide. The
// DOM node stays mounted when hidden (offscreen, pointer-events off) so
// CSS transitions can play both directions without a React unmount race.
// Anchored at bottom-right; sonner toasts sit at top-right.

import { useEffect, useMemo, useState } from 'react';
import { Loader2, X, Clock, Minimize2, Maximize2 } from 'lucide-react';
import { useApp } from '../context/AppContext';
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from './ui/tooltip';

function shortId(id: string | null): string {
  if (!id) return '';
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function clampPct(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  const pct = (value / max) * 100;
  if (pct < 0) return 0;
  if (pct > 100) return 100;
  return pct;
}

const COLLAPSED_KEY = 'runningTaskCard.collapsed';

export default function RunningTaskCard() {
  const { queueStatus, progress, activePromptId, cancelRunning } = useApp();
  const [cancelling, setCancelling] = useState(false);
  // Persist the collapse preference across page loads — users who always
  // want the slim bar shouldn't have to re-collapse every render.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(COLLAPSED_KEY) === '1'; }
    catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0'); }
    catch { /* localStorage unavailable */ }
  }, [collapsed]);

  const running = queueStatus?.queue_running ?? 0;
  const pending = queueStatus?.queue_pending ?? 0;

  const visible = useMemo(() => {
    if (running > 0 || pending > 0) return true;
    if (activePromptId) return true;
    if (progress) return true;
    return false;
  }, [running, pending, activePromptId, progress]);

  // Keep the DOM node mounted when hidden so the slide-out animation plays.
  // After a short delay past the transition end we can stop rendering state-
  // specific children (kept minimal: progress bar, prompt rows). Not strictly
  // necessary since they're hidden offscreen, but avoids stale React work.
  const [everShown, setEverShown] = useState(visible);
  useEffect(() => {
    if (visible) setEverShown(true);
  }, [visible]);
  if (!everShown) return null;

  const progressPct = progress ? clampPct(progress.value, progress.max) : null;
  const hasProgressBar = progressPct !== null;

  const handleCancel = async () => {
    if (cancelling) return;
    setCancelling(true);
    try {
      await cancelRunning();
    } finally {
      setCancelling(false);
    }
  };

  return (
    <TooltipProvider delayDuration={300}>
      <div
        role="status"
        aria-live="polite"
        aria-hidden={!visible}
        className={`fixed bottom-4 right-4 z-40 panel shadow-lg transition-all duration-500 ease-out ${
          collapsed ? 'w-[260px]' : 'w-[300px]'
        } ${
          visible
            ? 'translate-y-0 opacity-100'
            : 'translate-y-[calc(100%+1rem)] opacity-0 pointer-events-none'
        }`}
      >
        <div className="panel-header flex items-center gap-2">
          <span className="relative flex h-2 w-2 flex-shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-teal-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-teal-500" />
          </span>
          <span className="panel-header-title flex-1 truncate">Running in ComfyUI</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setCollapsed(v => !v)}
                className="btn-icon"
                aria-label={collapsed ? 'Expand card' : 'Minimize card'}
              >
                {collapsed
                  ? <Maximize2 className="h-3.5 w-3.5" />
                  : <Minimize2 className="h-3.5 w-3.5" />}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {collapsed ? 'Expand' : 'Minimize'}
            </TooltipContent>
          </Tooltip>
        </div>

        {collapsed ? (
          // Collapsed — progress bar + % only. No prompt/node rows, no
          // footer. Cancel stays reachable via the expanded view.
          <div className="px-3 py-2">
            {hasProgressBar ? (
              <div className="flex items-center gap-2">
                <div className="progress-track flex-1">
                  <div
                    className="progress-bar-fill"
                    style={{ width: `${progressPct}%` }}
                    aria-valuenow={progressPct ?? 0}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    role="progressbar"
                  />
                </div>
                <span className="text-[11px] tabular-nums text-slate-600 w-10 text-right">
                  {Math.round(progressPct!)}%
                </span>
              </div>
            ) : (
              <div className="progress-track">
                <div className="progress-bar-fill w-1/3 animate-pulse" />
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="px-4 py-3 space-y-2">
              {activePromptId && (
                <div className="flex items-center justify-between text-[11px] text-slate-500">
                  <span>Prompt</span>
                  <span className="font-mono text-slate-700">{shortId(activePromptId)}</span>
                </div>
              )}
              {progress?.nodeId && (
                <div className="flex items-center justify-between text-[11px] text-slate-500">
                  <span>Node</span>
                  <span className="font-mono text-slate-700 truncate max-w-[140px]" title={progress.nodeId}>
                    {progress.nodeId}
                  </span>
                </div>
              )}

              {hasProgressBar ? (
                <div className="space-y-1">
                  <div className="progress-track">
                    <div
                      className="progress-bar-fill"
                      style={{ width: `${progressPct}%` }}
                      aria-valuenow={progressPct ?? 0}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      role="progressbar"
                    />
                  </div>
                  <div className="flex justify-between text-[10px] text-slate-400 tabular-nums">
                    <span>{progress!.value}/{progress!.max}</span>
                    <span>{Math.round(progressPct!)}%</span>
                  </div>
                </div>
              ) : (
                // Indeterminate — subtle shimmer while we wait for the first
                // progress message (or when ComfyUI isn't emitting progress
                // for this workflow at all).
                <div className="progress-track">
                  <div className="progress-bar-fill w-1/3 animate-pulse" />
                </div>
              )}

              {pending > 0 && (
                <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
                  <Clock className="h-3 w-3" />
                  <span>
                    {pending} queued behind this
                  </span>
                </div>
              )}
            </div>

            <div className="panel-footer justify-end">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={handleCancel}
                    disabled={cancelling}
                    className="btn-secondary !border-red-200 !text-red-700 hover:!bg-red-50"
                  >
                    {cancelling
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : <X className="h-3.5 w-3.5" />}
                    <span>Cancel</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">Stop the current prompt</TooltipContent>
              </Tooltip>
            </div>
          </>
        )}
      </div>
    </TooltipProvider>
  );
}
