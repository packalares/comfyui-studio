import { useState, useEffect, useMemo } from 'react';
import {
  ChevronDown,
  Square,
  RotateCw,
  FileText,
  Trash2,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  X,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import { api } from '../services/comfyui';
import LogsDrawer from './LogsDrawer';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from './ui/alert-dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

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
      <AlertDialog open onOpenChange={(open) => !open && onClose()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Wipe and reinitialize ComfyUI?</AlertDialogTitle>
            <AlertDialogDescription>
              This stops ComfyUI and resets its state. Choose a mode:
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2 px-1">
            <label className="flex items-start gap-2 cursor-pointer p-2 rounded-md hover:bg-slate-50">
              <input
                type="radio"
                checked={mode === 'normal'}
                onChange={() => onModeChange('normal')}
                className="mt-1"
              />
              <div>
                <p className="text-xs font-medium text-slate-900">Normal</p>
                <p className="text-[11px] text-slate-500">Reset configuration and cache; keeps installed models and plugins.</p>
              </div>
            </label>
            <label className="flex items-start gap-2 cursor-pointer p-2 rounded-md hover:bg-slate-50 border border-red-100 bg-red-50/30">
              <input
                type="radio"
                checked={mode === 'hard'}
                onChange={() => onModeChange('hard')}
                className="mt-1"
              />
              <div>
                <p className="text-xs font-medium text-red-700">Hard</p>
                <p className="text-[11px] text-red-600/80">Aggressive wipe: everything goes except essential files. Not reversible.</p>
              </div>
            </label>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onConfirm} className="!bg-red-600 hover:!bg-red-700">
              <Trash2 className="w-3.5 h-3.5" />
              Wipe ({mode})
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  return (
    <div className="modal-overlay">
      <div className="fixed inset-0 bg-black/50" onClick={phase !== 'running' ? onClose : undefined} />
      <div className="panel relative w-full max-w-3xl max-h-[80vh] flex flex-col">
        <div className="panel-header flex items-center justify-between">
          <h3 className="panel-header-title flex items-center gap-2">
            {phase === 'running' && <Loader2 className="w-4 h-4 animate-spin text-amber-500" />}
            {phase === 'done' && <CheckCircle2 className="w-4 h-4 text-teal-600" />}
            {phase === 'error' && <AlertTriangle className="w-4 h-4 text-red-600" />}
            {phase === 'running' ? `Wiping (${mode})…` : phase === 'done' ? 'Wipe complete' : 'Wipe failed'}
          </h3>
          {phase !== 'running' && (
            <button onClick={onClose} className="btn-icon" aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        <div className="flex-1 overflow-auto p-4">
          <pre className="text-xs font-mono text-slate-700 whitespace-pre-wrap break-words bg-slate-50 rounded-lg p-4 min-h-[200px] ring-1 ring-inset ring-slate-200">
            {logs.length === 0 ? 'Starting…' : logs.join('\n')}
            {errorMsg && `\n\nError: ${errorMsg}`}
          </pre>
        </div>
        <div className="panel-footer justify-end">
          <button onClick={onClose} disabled={phase === 'running'} className="btn-secondary">
            {phase === 'running' ? 'Running…' : 'Close'}
          </button>
        </div>
      </div>
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
              className="inline-flex items-center justify-center rounded-l-none rounded-r-full h-7 px-2 text-xs font-medium bg-green-50 text-green-700 border border-green-200 hover:bg-green-100 transition-colors disabled:opacity-50"
              aria-label="ComfyUI actions"
              disabled={actionLoading !== null}
            >
              {actionLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <ChevronDown className="w-3 h-3" />}
            </button>
          </TooltipTrigger>
          <TooltipContent>ComfyUI actions</TooltipContent>
        </Tooltip>
        {dropdownOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setDropdownOpen(false)} />
            <div className="absolute right-0 mt-1 w-48 bg-white border border-slate-200 rounded-lg shadow-lg z-50 py-1">
              <button
                onClick={handleStop}
                disabled={actionLoading !== null}
                className="w-full text-left px-3 py-2 text-xs text-slate-700 hover:bg-slate-50 flex items-center gap-2 disabled:opacity-50"
              >
                <Square className="w-3.5 h-3.5 text-red-500" />
                Stop
              </button>
              <button
                onClick={handleRestart}
                disabled={actionLoading !== null || processStatus !== 'running'}
                className="w-full text-left px-3 py-2 text-xs text-slate-700 hover:bg-slate-50 flex items-center gap-2 disabled:opacity-50"
              >
                <RotateCw className="w-3.5 h-3.5 text-amber-500" />
                Restart
              </button>
              <div className="border-t border-slate-100 my-1" />
              <button
                onClick={() => { setDropdownOpen(false); setLogsOpen(true); }}
                className="w-full text-left px-3 py-2 text-xs text-slate-700 hover:bg-slate-50 flex items-center gap-2"
              >
                <FileText className="w-3.5 h-3.5 text-slate-400" />
                View Logs
              </button>
              <div className="border-t border-slate-100 my-1" />
              <button
                onClick={() => { setDropdownOpen(false); setWipePhase('confirm'); }}
                className="w-full text-left px-3 py-2 text-xs text-red-600 hover:bg-red-50 flex items-center gap-2"
              >
                <Trash2 className="w-3.5 h-3.5 text-red-400" />
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
