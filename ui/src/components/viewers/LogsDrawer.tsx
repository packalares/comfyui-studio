import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { X, RefreshCw, Eraser } from 'lucide-react';
import { api } from '../../services/comfyui';
import { Switch } from '../ui/switch';
import { Tooltip, TooltipTrigger, TooltipContent } from '../ui/tooltip';
import { Button } from '../ui/button';
import { Spinner } from '../ui/spinner';

interface Props {
  open: boolean;
  onClose: () => void;
}

const POLL_MS = 2000;

// The backend's `/comfyui/logs` handler returns `{ logs: string[] }`
// (see server/src/routes/comfyui.routes.ts:59-63, which forwards
// LogService.getRecentLogs()). The client TypeScript happens to say
// `{ logs: string }` — we guard for both shapes so we don't crash.
function normalizeLogs(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const logs = (payload as { logs?: unknown }).logs;
  if (Array.isArray(logs)) return logs.map((l) => String(l));
  if (typeof logs === 'string') return logs ? logs.split('\n') : [];
  return [];
}

export default function LogsDrawer({ open, onClose }: Props) {
  const [lines, setLines] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);

  // Follow-tail: only auto-scroll if the user is already pinned to the bottom.
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottomRef = useRef(true);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getComfyUILogs();
      setLines(normalizeLogs(data));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch logs');
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch when drawer opens.
  useEffect(() => {
    if (!open) return;
    pinnedToBottomRef.current = true;
    fetchLogs();
  }, [open, fetchLogs]);

  // Esc closes the drawer.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Auto-refresh polling. Clears on close / unmount / toggle-off.
  useEffect(() => {
    if (!open || !autoRefresh) return;
    pollTimerRef.current = setInterval(fetchLogs, POLL_MS);
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    };
  }, [open, autoRefresh, fetchLogs]);

  // Follow-tail: after lines change, scroll to bottom unless user scrolled up.
  useEffect(() => {
    if (!pinnedToBottomRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // 4px slack so smooth-scroll rounding doesn't un-pin us.
    pinnedToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
  }, []);

  // Split lines into render rows once per fetch (classification cached here, not in render).
  const rows = useMemo(
    () => lines.map((l) => ({ text: l, isError: /\bERROR:\s|\[ComfyUI-Error\]/.test(l) })),
    [lines],
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50">
      {/* Backdrop — matches AlertDialog's overlay style */}
      <div
        className="absolute inset-0 bg-black/50 animate-in fade-in-0"
        onClick={onClose}
      />
      {/* Right-side panel */}
      <div className="absolute right-0 top-0 bottom-0 w-full max-w-[640px] bg-card shadow-xl border-l flex flex-col animate-in slide-in-from-right duration-200">
        {/* Header — uses panel-header rules inlined here because the drawer
             shell is not a Card. */}
        <div className="border-b px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground">ComfyUI logs</h3>
            {loading && <Spinner size="sm" className="text-muted-foreground" />}
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Switch
                checked={autoRefresh}
                onCheckedChange={setAutoRefresh}
                aria-label="Toggle auto-refresh"
              />
              Auto-refresh
            </label>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button onClick={fetchLogs} disabled={loading} variant="ghost" size="icon" aria-label="Refresh logs">
                  <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Refresh</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  onClick={() => setLines([])}
                  variant="ghost"
                  size="icon"
                  aria-label="Clear view"
                >
                  <Eraser className="w-4 h-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Clear view (local only — does not wipe server logs)</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button onClick={onClose} variant="ghost" size="icon" aria-label="Close">
                  <X className="w-4 h-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Close</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Error banner (non-blocking) */}
        {error && (
          <div className="mx-4 mt-3 p-2.5 text-[11px] bg-destructive/10 text-destructive border border-destructive/30 rounded-lg">
            {error}
          </div>
        )}

        {/* Log viewport */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex-1 overflow-auto bg-muted m-4 rounded-lg ring-1 ring-inset ring-border"
        >
          {rows.length === 0 ? (
            <div className="h-full min-h-[200px] flex items-center justify-center p-6">
              <p className="text-xs text-muted-foreground">
                {loading ? 'Loading logs...' : 'No logs yet — start ComfyUI to see output.'}
              </p>
            </div>
          ) : (
            <pre className="text-[11px] leading-relaxed font-mono text-foreground p-3 whitespace-pre-wrap break-words">
              {rows.map((row, i) => (
                <div
                  key={i}
                  className={row.isError ? 'text-destructive' : undefined}
                >
                  {row.text || '\u00a0'}
                </div>
              ))}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
