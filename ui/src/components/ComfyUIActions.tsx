import { useState, useEffect, useMemo } from 'react';
import {
  ChevronDown,
  Square,
  RotateCw,
  FileText,
  Trash2,
  AlertTriangle,
  CheckCircle2,
  X,
} from 'lucide-react';
import { Spinner } from './ui/spinner';
import { useApp } from '../context/AppContext';
import { api } from '../services/comfyui';
import LogsDrawer from './viewers/LogsDrawer';
import ConfirmDialog from './modals/ConfirmDialog';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { Button } from './ui/button';
import { Card, CardContent, CardFooter, CardHeader } from './ui/card';

type ProcessStatus = 'running' | 'stopped' | 'starting' | 'unknown';
type WipePhase = 'confirm' | 'running' | 'done' | 'error';

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
              <p className="text-[11px] text-muted-foreground">Reset configuration and cache; keeps installed models and plugins.</p>
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
              <p className="text-[11px] text-destructive/80">Aggressive wipe: everything goes except essential files. Not reversible.</p>
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

export default function ComfyUIActions() {
  const { launcherStatus } = useApp();
  const [optimistic, setOptimistic] = useState<ProcessStatus | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [wipePhase, setWipePhase] = useState<WipePhase | null>(null);
  const [wipeMode, setWipeMode] = useState<'normal' | 'hard'>('normal');
  const [wipeLogs, setWipeLogs] = useState<string[]>([]);
  const [wipeError, setWipeError] = useState<string | null>(null);

  const processStatus = useMemo<ProcessStatus>(() => {
    if (optimistic) return optimistic;
    if (!launcherStatus) return 'unknown';
    if (launcherStatus.reachable === false) return 'unknown';
    return launcherStatus.running ? 'running' : 'stopped';
  }, [launcherStatus, optimistic]);

  useEffect(() => {
    if (!optimistic || !launcherStatus) return;
    const real: ProcessStatus = launcherStatus.reachable === false
      ? 'unknown'
      : launcherStatus.running ? 'running' : 'stopped';
    if (real === optimistic) setOptimistic(null);
  }, [launcherStatus, optimistic]);

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

  const handleStop = async () => {
    setDropdownOpen(false);
    setActionLoading('stop');
    try {
      await api.stopComfyUI();
      setOptimistic('stopped');
    } finally {
      setActionLoading(null);
    }
  };

  const handleRestart = async () => {
    setDropdownOpen(false);
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

  if (processStatus !== 'running' && processStatus !== 'starting') return null;

  return (
    <>
      <div className="relative -ml-px">
        {/* `-ml-px` lets the chevron's left border sit flush with the pill's
            right edge so the status + dropdown read as a single grouped
            control rather than two separate buttons. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => setDropdownOpen(v => !v)}
              className="inline-flex items-center justify-center rounded-l-none rounded-r-full h-7 px-2 text-xs font-medium bg-success/10 text-success border border-success/30 hover:bg-success/20 transition-colors disabled:opacity-50"
              aria-label="ComfyUI actions"
              disabled={actionLoading !== null}
            >
              {actionLoading ? <Spinner size="xs" /> : <ChevronDown className="w-3 h-3" />}
            </button>
          </TooltipTrigger>
          <TooltipContent>ComfyUI actions</TooltipContent>
        </Tooltip>
        {dropdownOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setDropdownOpen(false)} />
            <div className="absolute right-0 mt-1 w-48 bg-popover border rounded-lg shadow-lg z-50 py-1">
              <button
                onClick={handleStop}
                disabled={actionLoading !== null}
                className="w-full text-left px-3 py-2 text-xs text-foreground hover:bg-muted flex items-center gap-2 disabled:opacity-50"
              >
                <Square className="w-3.5 h-3.5 text-destructive" />
                Stop
              </button>
              <button
                onClick={handleRestart}
                disabled={actionLoading !== null || processStatus !== 'running'}
                className="w-full text-left px-3 py-2 text-xs text-foreground hover:bg-muted flex items-center gap-2 disabled:opacity-50"
              >
                <RotateCw className="w-3.5 h-3.5 text-warning" />
                Restart
              </button>
              <div className="border-t my-1" />
              <button
                onClick={() => { setDropdownOpen(false); setLogsOpen(true); }}
                className="w-full text-left px-3 py-2 text-xs text-foreground hover:bg-muted flex items-center gap-2"
              >
                <FileText className="w-3.5 h-3.5 text-muted-foreground" />
                View Logs
              </button>
              <div className="border-t my-1" />
              <button
                onClick={() => { setDropdownOpen(false); setWipePhase('confirm'); }}
                className="w-full text-left px-3 py-2 text-xs text-destructive hover:bg-destructive/10 flex items-center gap-2"
              >
                <Trash2 className="w-3.5 h-3.5 text-destructive" />
                Wipe and Reinitialize
              </button>
            </div>
          </>
        )}
      </div>

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
