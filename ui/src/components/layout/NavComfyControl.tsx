// Sidebar-footer ComfyUI control — modeled on shadcn-admin's nav-user pattern.
// One SidebarMenuButton showing live status; clicking opens a Radix
// DropdownMenu to the right (side="right" align="end") so the panel never
// slides off-screen the way an absolute-positioned dropdown can.

import { useEffect, useMemo, useState } from 'react';
import {
  Wifi, WifiOff, Play, ChevronsUpDown, Square, RotateCw, FileText,
  Trash2, AlertTriangle, CheckCircle2, X,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { api } from '../../services/comfyui';
import { Spinner } from '../ui/spinner';
import { Button } from '../ui/button';
import { Card, CardContent, CardFooter, CardHeader } from '../ui/card';
import ConfirmDialog from '../modals/ConfirmDialog';
import LogsDrawer from '../viewers/LogsDrawer';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuSeparator, DropdownMenuLabel,
} from '../ui/dropdown-menu';
import { SidebarMenu, SidebarMenuItem, SidebarMenuButton } from '../ui/sidebar';

type ProcessStatus = 'running' | 'stopped' | 'starting' | 'unknown';
type WipePhase = 'confirm' | 'running' | 'done' | 'error';

export default function NavComfyControl() {
  const { connected, launcherStatus, loading } = useApp();
  const [optimistic, setOptimistic] = useState<ProcessStatus | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [wipePhase, setWipePhase] = useState<WipePhase | null>(null);
  const [wipeMode, setWipeMode] = useState<'normal' | 'hard'>('normal');
  const [wipeLogs, setWipeLogs] = useState<string[]>([]);
  const [wipeError, setWipeError] = useState<string | null>(null);

  // Definitive status known once /system has responded OR any launcher-status
  // WS event has arrived; avoids the red Disconnected flash on cold boot.
  const statusKnown = !loading || launcherStatus !== null;

  const processStatus = useMemo<ProcessStatus>(() => {
    if (optimistic) return optimistic;
    if (!launcherStatus) return 'unknown';
    if (launcherStatus.reachable === false) return 'unknown';
    return launcherStatus.running ? 'running' : 'stopped';
  }, [launcherStatus, optimistic]);

  // Clear optimistic flag once real state catches up.
  useEffect(() => {
    if (!optimistic || !launcherStatus) return;
    const real: ProcessStatus = launcherStatus.reachable === false
      ? 'unknown'
      : launcherStatus.running ? 'running' : 'stopped';
    if (real === optimistic) setOptimistic(null);
  }, [launcherStatus, optimistic]);

  // Clear "starting" once the server confirms running.
  useEffect(() => {
    if (starting && launcherStatus?.running) setStarting(false);
  }, [starting, launcherStatus]);

  // Live-tail wipe logs while the reset runs.
  useEffect(() => {
    if (wipePhase !== 'running') return;
    let cancelled = false;
    const tick = async () => {
      try {
        const data = await api.getResetLogs();
        if (!cancelled) setWipeLogs(data.logs || []);
      } catch { /* ignore */ }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => { cancelled = true; clearInterval(id); };
  }, [wipePhase]);

  const handleStart = async () => {
    setStarting(true);
    try { await api.startComfyUI(); }
    catch { setStarting(false); }
  };

  const handleStop = async () => {
    setActionLoading('stop');
    try {
      await api.stopComfyUI();
      setOptimistic('stopped');
    } finally {
      setActionLoading(null);
    }
  };

  const handleRestart = async () => {
    setActionLoading('restart');
    try {
      await api.restartComfyUI();
      setOptimistic('starting');
    } finally {
      setActionLoading(null);
    }
  };

  const startWipe = async () => {
    setWipeLogs([]);
    setWipeError(null);
    setWipePhase('running');
    try {
      const result = await api.resetComfyUI(wipeMode);
      if (result.logs) setWipeLogs(result.logs);
      setWipePhase(result.success ? 'done' : 'error');
      if (!result.success) setWipeError(result.message || 'Reset failed');
    } catch (err) {
      setWipeError(String(err));
      setWipePhase('error');
    }
  };

  const closeWipe = () => {
    if (wipePhase === 'running') return;
    setWipePhase(null);
    setWipeLogs([]);
    setWipeError(null);
  };

  // ---- Trigger button: status-aware look ---------------------------------

  const stopping = actionLoading === 'stop' || optimistic === 'stopped';
  const restarting = actionLoading === 'restart' || optimistic === 'starting';

  const triggerContent = (() => {
    if (!statusKnown) {
      return (
        <>
          <Spinner size="xs" />
          <span className="text-xs group-data-[collapsible=icon]:hidden">Checking…</span>
        </>
      );
    }
    if (starting) {
      return (
        <>
          <Spinner size="xs" />
          <span className="text-xs group-data-[collapsible=icon]:hidden">Starting…</span>
        </>
      );
    }
    if (stopping) {
      return (
        <>
          <Spinner size="xs" />
          <span className="text-xs group-data-[collapsible=icon]:hidden">Stopping…</span>
        </>
      );
    }
    if (restarting) {
      return (
        <>
          <Spinner size="xs" />
          <span className="text-xs group-data-[collapsible=icon]:hidden">Restarting…</span>
        </>
      );
    }
    if (connected) {
      return (
        <>
          <Wifi className="text-success" />
          <div className="flex-1 min-w-0 group-data-[collapsible=icon]:hidden">
            <div className="text-xs font-medium">ComfyUI</div>
            <div className="text-[10px] text-muted-foreground truncate">Connected</div>
          </div>
          <ChevronsUpDown className="ml-auto opacity-60 group-data-[collapsible=icon]:hidden" />
        </>
      );
    }
    return (
      <>
        <WifiOff className="text-destructive" />
        <div className="flex-1 min-w-0 group-data-[collapsible=icon]:hidden">
          <div className="text-xs font-medium">ComfyUI</div>
          <div className="text-[10px] text-muted-foreground truncate">Disconnected</div>
        </div>
        <Play className="ml-auto group-data-[collapsible=icon]:hidden" />
      </>
    );
  })();

  // ---- Render -----------------------------------------------------------

  // Disconnected (and not in transient states) → click starts ComfyUI directly,
  // no dropdown. Mirrors the pre-redesign UX.
  if (statusKnown && !starting && !connected) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            size="lg"
            variant="outline"
            onClick={handleStart}
            tooltip="ComfyUI is not running — click to start"
            className="group-data-[collapsible=icon]:justify-center"
          >
            {triggerContent}
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }

  // Connected (or transient) → dropdown of actions. Disabled during transient
  // states (Checking / Starting) so the user can't fire actions before the
  // server is ready.
  const actionsDisabled = !connected || actionLoading !== null;

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton
                size="lg"
                variant="outline"
                className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground group-data-[collapsible=icon]:justify-center"
              >
                {triggerContent}
              </SidebarMenuButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side="top"
              align="end"
              sideOffset={8}
              className="rounded-xl"
            >
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                ComfyUI
              </DropdownMenuLabel>
              <DropdownMenuItem onClick={handleStop} disabled={actionsDisabled}>
                <Square className="text-destructive" />
                Stop
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={handleRestart}
                disabled={actionsDisabled || processStatus !== 'running'}
              >
                <RotateCw className="text-warning" />
                Restart
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setLogsOpen(true)}>
                <FileText className="text-muted-foreground" />
                View Logs
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => setWipePhase('confirm')}
                variant="destructive"
              >
                <Trash2 />
                Wipe and Reinitialize
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>

      <LogsDrawer open={logsOpen} onClose={() => setLogsOpen(false)} />

      {wipePhase && (
        <WipeModal
          phase={wipePhase}
          mode={wipeMode}
          logs={wipeLogs}
          errorMsg={wipeError}
          onModeChange={setWipeMode}
          onConfirm={startWipe}
          onClose={closeWipe}
        />
      )}
    </>
  );
}

// ---- Wipe modal (lifted from ComfyUIActions for self-containment) -------

function WipeModal({
  phase, mode, logs, errorMsg, onModeChange, onConfirm, onClose,
}: {
  phase: WipePhase;
  mode: 'normal' | 'hard';
  logs: string[];
  errorMsg: string | null;
  onModeChange: (m: 'normal' | 'hard') => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  if (phase === 'confirm') {
    return (
      <ConfirmDialog
        open
        onClose={onClose}
        title="Wipe and reinitialize ComfyUI?"
        description="This stops ComfyUI and resets its state. Choose a mode:"
        confirmLabel={`Wipe (${mode})`}
        confirmTone="danger"
        onConfirm={onConfirm}
      >
        <div className="space-y-2 px-1 mt-2">
          <label className="flex items-start gap-2 cursor-pointer p-2 rounded-md hover:bg-muted">
            <input
              type="radio"
              checked={mode === 'normal'}
              onChange={() => onModeChange('normal')}
              className="mt-1"
            />
            <div>
              <p className="text-xs font-medium text-foreground">Normal</p>
              <p className="text-[11px] text-muted-foreground">
                Reset configuration and cache; keeps installed models and plugins.
              </p>
            </div>
          </label>
          <label className="flex items-start gap-2 cursor-pointer p-2 rounded-md hover:bg-muted border border-destructive/30 bg-destructive/10">
            <input
              type="radio"
              checked={mode === 'hard'}
              onChange={() => onModeChange('hard')}
              className="mt-1"
            />
            <div>
              <p className="text-xs font-medium text-destructive">Hard</p>
              <p className="text-[11px] text-destructive/80">
                Aggressive wipe: everything goes except essential files. Not reversible.
              </p>
            </div>
          </label>
        </div>
      </ConfirmDialog>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/50" onClick={phase !== 'running' ? onClose : undefined} />
      <Card className="relative w-full max-w-3xl max-h-[80vh] flex flex-col">
        <CardHeader className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            {phase === 'running' && <Spinner size="md" className="text-warning" />}
            {phase === 'done' && <CheckCircle2 className="w-4 h-4 text-brand" />}
            {phase === 'error' && <AlertTriangle className="w-4 h-4 text-destructive" />}
            {phase === 'running' ? `Wiping (${mode})…` : phase === 'done' ? 'Wipe complete' : 'Wipe failed'}
          </h3>
          {phase !== 'running' && (
            <Button onClick={onClose} variant="ghost" size="icon" aria-label="Close">
              <X className="w-4 h-4" />
            </Button>
          )}
        </CardHeader>
        <CardContent className="flex-1 overflow-auto">
          <pre className="text-xs font-mono text-foreground whitespace-pre-wrap break-words bg-muted rounded-lg p-4 min-h-[200px] ring-1 ring-inset ring-border">
            {logs.length === 0 ? 'Starting…' : logs.join('\n')}
            {errorMsg && `\n\nError: ${errorMsg}`}
          </pre>
        </CardContent>
        <CardFooter className="justify-end">
          <Button onClick={onClose} disabled={phase === 'running'} variant="secondary">
            {phase === 'running' ? 'Running…' : 'Close'}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
