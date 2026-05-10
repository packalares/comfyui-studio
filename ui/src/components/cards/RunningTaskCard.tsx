// ComfyUI activity indicator that lives in the sidebar footer.
//
// Two render modes (driven by the sidebar's collapsible state):
//   - Sidebar expanded: inline card. Defaults to a slim view (header +
//     progress bar). Click the chevron to expand to the full prompt /
//     queued / cancel pane.
//   - Sidebar icon-only: a single pulsing dot button. Click opens a
//     <Popover> with the same card body — the icon strip is too narrow
//     for an inline card.
//
// Mounted only when ComfyUI's queue has anything running/pending or we
// are receiving progress events; idle returns null (no DOM, no popover).

import { useEffect, useMemo, useState } from 'react';
import { X, Clock, ChevronDown, ChevronUp } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { useSidebar } from '../ui/sidebar';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Button } from '../ui/button';
import { Spinner } from '../ui/spinner';

const COLLAPSED_KEY = 'runningTaskCard.collapsed';

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

export default function RunningTaskCard() {
  const { queueStatus, progress, activePromptId, cancelRunning } = useApp();
  const { state, isMobile } = useSidebar();
  const [cancelling, setCancelling] = useState(false);

  // Default to the slim view — most users only want the at-a-glance
  // progress bar; opening the full pane is opt-in. localStorage persists
  // the choice across sessions.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(COLLAPSED_KEY);
      return raw === null ? true : raw === '1';
    } catch { return true; }
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

  if (!visible) return null;

  const progressPct = progress ? clampPct(progress.value, progress.max) : null;
  const hasProgressBar = progressPct !== null;

  const handleCancel = async () => {
    if (cancelling) return;
    setCancelling(true);
    try { await cancelRunning(); }
    finally { setCancelling(false); }
  };

  const cardBody = (
    <div className="rounded-md border bg-card text-card-foreground shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span className="relative flex h-2 w-2 flex-shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand/70 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-brand" />
        </span>
        <span className="flex-1 truncate text-xs font-semibold text-foreground">
          Running in ComfyUI
        </span>
        <button
          type="button"
          onClick={() => setCollapsed(v => !v)}
          aria-label={collapsed ? 'Expand details' : 'Collapse details'}
          className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer transition-colors"
        >
          {collapsed
            ? <ChevronDown className="h-3.5 w-3.5" />
            : <ChevronUp className="h-3.5 w-3.5" />}
        </button>
      </div>

      {collapsed ? (
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
              <span className="w-10 text-right text-[11px] tabular-nums text-foreground">
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
          <div className="space-y-2 px-3 py-2">
            {activePromptId && (
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>Prompt</span>
                <span className="font-mono text-foreground">{shortId(activePromptId)}</span>
              </div>
            )}
            {progress?.nodeId && (
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>Node</span>
                <span
                  className="max-w-[140px] truncate font-mono text-foreground"
                  title={progress.nodeId}
                >
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
                <div className="flex justify-between text-[10px] tabular-nums text-muted-foreground">
                  <span>{progress!.value}/{progress!.max}</span>
                  <span>{Math.round(progressPct!)}%</span>
                </div>
              </div>
            ) : (
              <div className="progress-track">
                <div className="progress-bar-fill w-1/3 animate-pulse" />
              </div>
            )}

            {pending > 0 && (
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <Clock className="h-3 w-3" />
                <span>{pending} queued behind this</span>
              </div>
            )}
          </div>

          <div className="flex justify-end border-t px-3 py-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={handleCancel}
                  disabled={cancelling}
                  className="!border-destructive/30 !text-destructive hover:!bg-destructive/10"
                >
                  {cancelling
                    ? <Spinner size="sm" />
                    : <X className="h-3.5 w-3.5" />}
                  <span>Cancel</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">Stop the current prompt</TooltipContent>
            </Tooltip>
          </div>
        </>
      )}
    </div>
  );

  // On desktop, when the sidebar is icon-only, render a pulsing dot button
  // that opens the full card in a Popover. Mobile sidebars are sheet-style
  // and always have full width when open, so we treat them as expanded.
  const showAsIcon = !isMobile && state === 'collapsed';

  if (showAsIcon) {
    return (
      <TooltipProvider delayDuration={300}>
        <div className="flex justify-center px-1 py-1">
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label="ComfyUI is running — click for details"
                className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted cursor-pointer transition-colors"
              >
                <span className="relative flex h-2.5 w-2.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand/70 opacity-75" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-brand" />
                </span>
              </button>
            </PopoverTrigger>
            <PopoverContent side="right" align="end" className="w-[280px] p-0">
              {cardBody}
            </PopoverContent>
          </Popover>
        </div>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delayDuration={300}>
      {cardBody}
    </TooltipProvider>
  );
}
