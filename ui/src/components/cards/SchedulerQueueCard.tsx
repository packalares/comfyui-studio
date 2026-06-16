// Studio scheduler activity indicator, lives in the sidebar footer next to
// the existing ComfyUI RunningTaskCard. Shows the Studio-side queue + a
// best-effort summary of ComfyUI's own queue (comfy-direct submissions the
// scheduler didn't see), plus active-age and cancel-all / cancel-active
// escape hatches. Idle returns null so we don't clutter the sidebar when
// nothing is happening.
//
// Data path: `gpuSnapshot` is pushed over the shared /ws by the server on
// scheduler state changes + ComfyUI bridge status events. No HTTP polling.

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Layers, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../ui/button';
import { useSidebar } from '../ui/sidebar';
import { useApp } from '../../context/AppContext';

// Threshold past which we badge the active job as "long-running" — it might
// be legitimately working OR the slot may have leaked. Visual hint, not a
// terminal verdict.
const SLOT_AGE_WARN_MS = 5 * 60_000;

function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m`;
}

export default function SchedulerQueueCard() {
  const { state, isMobile } = useSidebar();
  const { gpuSnapshot: snap } = useApp();
  const [now, setNow] = useState<number>(() => Date.now());
  const [cancelling, setCancelling] = useState(false);
  const [releasing, setReleasing] = useState(false);

  // Tick `now` once a second so the "active for Xs" label moves smoothly
  // even between snapshot polls. Only runs when something is active.
  useEffect(() => {
    if (!snap?.active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [snap?.active]);

  const handleCancelAll = useCallback(async () => {
    if (cancelling) return;
    setCancelling(true);
    try {
      const r = await fetch('/api/gpu/queue', { method: 'DELETE', credentials: 'include' });
      if (!r.ok) throw new Error(`cancel-all failed (${r.status})`);
      const body = await r.json() as { data?: { cancelled: number } };
      const n = body.data?.cancelled ?? 0;
      if (n === 0) toast.info('Nothing queued to cancel');
      else toast.success(`Cancelled ${n} queued job${n === 1 ? '' : 's'}`);
    } catch (err) {
      toast.error('Cancel failed', {
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      setCancelling(false);
    }
  }, [cancelling]);

  const handleForceRelease = useCallback(async () => {
    if (releasing) return;
    setReleasing(true);
    try {
      const r = await fetch('/api/gpu/active', { method: 'DELETE', credentials: 'include' });
      if (!r.ok) throw new Error(`force-release failed (${r.status})`);
      const body = await r.json() as { data?: { released: boolean } };
      if (body.data?.released) toast.success('Active slot released');
      else toast.info('No active slot to release');
    } catch (err) {
      toast.error('Force-release failed', {
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      setReleasing(false);
    }
  }, [releasing]);

  if (!snap) return null;
  const queued = snap.queue.length;
  const hasActive = snap.active !== null;
  const comfy = snap.comfy;
  // External activity = ComfyUI's queue_remaining that Studio didn't submit.
  // queueRemaining is total (running + pending); studioTracked counts only the
  // CURRENTLY-EXECUTING tracked subset. As a best-effort estimate of external
  // work, subtract our scheduler's awareness from comfy's total.
  const external = (() => {
    if (comfy.queueRemaining === null) return 0;
    // Studio jobs currently in flight on comfy (active + queued for the comfy tenant).
    const studioComfyActive =
      hasActive && snap.active?.tenant === 'comfy' ? 1 : 0;
    const studioComfyQueued = snap.queue.filter(j => j.tenant === 'comfy').length;
    const studioTotal = studioComfyActive + studioComfyQueued;
    return Math.max(0, comfy.queueRemaining - studioTotal);
  })();

  // Nothing studio-visible AND nothing external? Hide the card.
  if (queued === 0 && !hasActive && external === 0) return null;

  const ageMs = hasActive && snap.active ? now - snap.active.startedAt : 0;
  const ageWarn = ageMs > SLOT_AGE_WARN_MS;

  const isCollapsedSidebar = !isMobile && state === 'collapsed';
  if (isCollapsedSidebar) {
    // Icon-only sidebar: tiny chip with combined queue count.
    const totalBadge = queued + external;
    return (
      <div className="flex items-center justify-center py-1">
        <div className="relative">
          <Layers className={`h-4 w-4 ${ageWarn ? 'text-amber-500' : 'text-muted-foreground'}`} />
          {totalBadge > 0 && (
            <span className="absolute -right-1.5 -top-1.5 inline-flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-primary px-1 text-[9px] font-medium text-primary-foreground">
              {totalBadge > 99 ? '99+' : totalBadge}
            </span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-md border bg-card/40 p-2 text-xs">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
          <Layers className="h-3.5 w-3.5 text-muted-foreground" />
          Scheduler
        </span>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {snap.residency}
        </span>
      </div>
      <div className="space-y-0.5 text-muted-foreground">
        <div className="flex justify-between">
          <span>Active</span>
          <span className="text-foreground font-mono inline-flex items-center gap-1">
            {hasActive
              ? <>
                  <span>{snap.active!.taskType}</span>
                  <span className={ageWarn ? 'text-amber-500' : 'text-muted-foreground'}>
                    · {formatAge(ageMs)}
                  </span>
                  {ageWarn && <AlertTriangle className="h-3 w-3 text-amber-500" />}
                </>
              : '—'}
          </span>
        </div>
        <div className="flex justify-between">
          <span>Queued</span>
          <span className="text-foreground font-mono">{queued}</span>
        </div>
        {(external > 0 || !comfy.connected) && (
          <div className="flex justify-between">
            <span className={comfy.connected ? '' : 'text-amber-500'}>
              ext{comfy.connected ? '' : ' · WS down'}
            </span>
            <span className="text-foreground font-mono">{external}</span>
          </div>
        )}
      </div>
      {queued > 0 && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="mt-2 w-full h-7 text-[11px]"
          onClick={handleCancelAll}
          disabled={cancelling}
        >
          <X className="h-3 w-3" />
          {cancelling ? 'Cancelling…' : `Cancel ${queued} queued`}
        </Button>
      )}
      {/* Active force-release only when the slot looks stuck. Avoid offering
          it for fresh jobs (would just be a footgun for "be patient"). */}
      {hasActive && ageWarn && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-2 w-full h-7 text-[11px] border-amber-500/40 text-amber-600 hover:bg-amber-500/10"
          onClick={handleForceRelease}
          disabled={releasing}
        >
          <AlertTriangle className="h-3 w-3" />
          {releasing ? 'Releasing…' : 'Force-release active'}
        </Button>
      )}
    </div>
  );
}
