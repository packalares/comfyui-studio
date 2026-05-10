// Live GPU + VRAM indicator that lives in the sidebar footer.
//
// Two render modes (driven by the sidebar's collapsible state):
//   - Sidebar expanded: compact card with GPU name + VRAM progress bar.
//     Defaults to a slim view; click the chevron to expand to the
//     used/total + percent line.
//   - Sidebar icon-only: a single Cpu icon button. Click opens a
//     <Popover> with the same body.
//
// Mounted only when ComfyUI reports at least one GPU device. No GPU →
// returns null (no DOM, no popover).

import { useEffect, useState } from 'react';
import { Cpu, ChevronDown, ChevronUp } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { useSidebar } from '../ui/sidebar';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

const COLLAPSED_KEY = 'gpuStatusCard.collapsed';

function formatBytes(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  return `${gb.toFixed(1)} GB`;
}

function clampPct(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  if (pct < 0) return 0;
  if (pct > 100) return 100;
  return pct;
}

function vramTone(pct: number): string {
  // Green under 70 %, amber 70–90, red above. Tracks the same thresholds
  // the dashboard's old GPU card used so the visual cue is consistent.
  if (pct > 90) return 'bg-red-500';
  if (pct > 70) return 'bg-warning';
  return 'bg-brand';
}

export default function GpuStatusCard() {
  const { systemStats, monitorStats } = useApp();
  const { state, isMobile } = useSidebar();

  // Default to slim — most users only want the GPU name + progress bar
  // glanceable; expanding to the percent line is opt-in. localStorage
  // persists the choice across sessions.
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

  const gpu = systemStats && systemStats.devices.length > 0
    ? systemStats.devices[0]
    : null;
  // Only trust VRAM after the first crystools.monitor WS tick — the
  // initial /system GET can return vram_used==vram_total as a placeholder
  // before sampling has run. Without this the bar shows 100 % on boot.
  const vramReady = !!gpu && gpu.vram_total > 0 && monitorStats != null;
  const vramPct = vramReady ? clampPct((gpu!.vram_used / gpu!.vram_total) * 100) : 0;

  if (!gpu) return null;

  const cardBody = (
    <div className="rounded-md border bg-card text-card-foreground shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Cpu className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span
          className="flex-1 truncate text-xs font-semibold text-foreground"
          title={gpu.name}
        >
          {gpu.name}
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

      <div className="px-3 py-2">
        {vramReady ? (
          <>
            {!collapsed && (
              <div className="mb-1 flex justify-between text-[11px] text-muted-foreground">
                <span>VRAM</span>
                <span>
                  {formatBytes(gpu.vram_used)} / {formatBytes(gpu.vram_total)}
                </span>
              </div>
            )}
            <div className="progress-track">
              <div
                className={`h-full rounded-full transition-all ${vramTone(vramPct)}`}
                style={{ width: `${vramPct}%` }}
                aria-valuenow={Math.round(vramPct)}
                aria-valuemin={0}
                aria-valuemax={100}
                role="progressbar"
              />
            </div>
            {!collapsed && (
              <div className="mt-1 text-right text-[10px] tabular-nums text-muted-foreground">
                {Math.round(vramPct)}%
              </div>
            )}
          </>
        ) : (
          <div className="text-[11px] text-muted-foreground">
            Sampling VRAM…
          </div>
        )}
      </div>
    </div>
  );

  // Desktop + icon-only sidebar → Cpu icon trigger that opens the full
  // card body in a Popover. Mobile sidebars are sheet-style and always
  // expanded when open, so we treat them as desktop-expanded.
  const showAsIcon = !isMobile && state === 'collapsed';

  if (showAsIcon) {
    return (
      <div className="flex justify-center px-1 py-1">
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={`GPU: ${gpu.name}`}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer transition-colors"
            >
              <Cpu className="h-4 w-4" />
            </button>
          </PopoverTrigger>
          <PopoverContent side="right" align="end" className="w-[280px] p-0">
            {cardBody}
          </PopoverContent>
        </Popover>
      </div>
    );
  }

  return cardBody;
}
