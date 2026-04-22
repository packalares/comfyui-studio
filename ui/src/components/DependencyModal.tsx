import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle, Download, Loader2, CheckCircle2, AlertCircle, Lock,
  X, Box,
  FolderOpen, HardDrive,
} from 'lucide-react';
import type { RequiredModel } from '../types';
import { findDownloadForModel } from '../types';
import { api } from '../services/comfyui';
import { useApp } from '../context/AppContext';
import AppModal from './AppModal';

// ---------------------------------------------------------------------------
// Visual mapping (old -> new), so future edits stay consistent with
// ImportWorkflowModal's idiom:
//   .fixed inset-0 z-50 bg-black/50          -> AppModal (.modal-overlay)
//   white rounded-xl shadow-xl panel wrapper -> AppModal's .panel shell
//   header px-6 py-4 border-b                -> AppModal default header
//   body px-6 py-4                           -> AppModal children slot
//   footer px-6 py-4 border-t bg-gray-50     -> AppModal `.panel-footer` slot
//   per-row bg-gray-50 rounded-lg            -> rounded-lg border border-slate-200 bg-white p-3
//   amber gated banner                       -> rose/amber info strip like the error strip
//   custom teal bar                          -> .progress-track + .progress-bar-fill
//   Status icon (Check/XCircle/Loader2)      -> CheckCircle2 / AlertCircle / Loader2
//   bespoke teal "Download all" button       -> .btn-primary
//   bespoke white ghost buttons              -> .btn-secondary
// ---------------------------------------------------------------------------

interface Props {
  missing: RequiredModel[];
  onClose: () => void;
  onDownloadComplete: () => void;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes === 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

interface ViewState {
  status: 'pending' | 'downloading' | 'completed' | 'error';
  taskId?: string;
  progress: number;
  speed?: number;
  error?: string;
}

export default function DependencyModal({ missing, onClose, onDownloadComplete }: Props) {
  const navigate = useNavigate();
  const { downloads, hfTokenConfigured } = useApp();
  // Per-model pending/error state that isn't captured by the global downloads map
  // (e.g. "starting" before the backend has assigned a taskId, or no-URL errors).
  const [localState, setLocalState] = useState<Map<string, ViewState>>(new Map());
  const [starting, setStarting] = useState(false);
  const completedFiredRef = useRef(false);

  const totalSize = missing.reduce((sum, m) => sum + (m.size || 0), 0);

  // Merge local placeholders + live WS downloads (matched by name/filename) into one view.
  const view: Map<string, ViewState> = useMemo(() => {
    const m = new Map<string, ViewState>();
    for (const model of missing) {
      const live = findDownloadForModel(downloads, { name: model.name });
      const local = localState.get(model.name);
      if (live) {
        if (live.completed || live.status === 'completed') {
          m.set(model.name, { status: 'completed', taskId: live.taskId, progress: 100, speed: 0 });
        } else if (live.status === 'error') {
          m.set(model.name, { status: 'error', taskId: live.taskId, progress: live.progress, error: live.error || 'Download failed' });
        } else {
          m.set(model.name, { status: 'downloading', taskId: live.taskId, progress: live.progress, speed: live.speed });
        }
      } else if (local) {
        m.set(model.name, local);
      }
    }
    return m;
  }, [missing, localState, downloads]);

  useEffect(() => {
    if (completedFiredRef.current) return;
    if (view.size !== missing.length) return;
    const allDone = Array.from(view.values()).every(v => v.status === 'completed');
    if (!allDone) return;
    completedFiredRef.current = true;
    // Brief "all done" state before we fire the close-on-complete callback.
    // The cleanup clears the timer so a user-initiated close in this window
    // doesn't land onDownloadComplete on the unmounted modal.
    const id = setTimeout(onDownloadComplete, 500);
    return () => { clearTimeout(id); };
  }, [view, missing.length, onDownloadComplete]);

  const handleDownloadAll = useCallback(async () => {
    setStarting(true);
    completedFiredRef.current = false;

    for (const model of missing) {
      // Skip if a download for this model is already running.
      if (findDownloadForModel(downloads, { name: model.name })) continue;
      if (!model.url) {
        setLocalState(prev => new Map(prev).set(model.name, { status: 'error', progress: 0, error: 'No download URL available' }));
        continue;
      }
      // Gated models without an HF token configured would 401 at the launcher — skip
      // and leave the gated badge visible so the user can add a token and retry.
      if (model.gated && !hfTokenConfigured) continue;
      setLocalState(prev => new Map(prev).set(model.name, { status: 'downloading', progress: 0 }));
      try {
        await api.downloadCustomModel(model.url, model.directory || 'checkpoints', {
          modelName: model.name,
          filename: model.name,
        });
        // Keep the local 'downloading' placeholder; it's overridden by the live WS state
        // inside `view` once the first progress message arrives.
      } catch (err) {
        setLocalState(prev => new Map(prev).set(model.name, { status: 'error', progress: 0, error: String(err) }));
      }
    }
    setStarting(false);
  }, [missing, downloads, hfTokenConfigured]);

  const isAnyActive = Array.from(view.values()).some(d => d.status === 'downloading');
  const anyError = !isAnyActive && Array.from(view.values()).some(d => d.status === 'error');
  const canStart = view.size === 0 || anyError;
  const gatedBlocked = missing.some(m => m.gated) && !hfTokenConfigured;

  return (
    <AppModal
      open={true}
      onClose={onClose}
      title="Missing dependencies"
      subtitle={
        isAnyActive
          ? 'Downloading required models…'
          : 'These models are referenced by the workflow but not installed.'
      }
      icon={
        <div className="rounded-md bg-amber-50 p-1.5 ring-1 ring-inset ring-amber-200">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
        </div>
      }
      size="md"
      disableClose={isAnyActive}
      footer={
        <>
          <div className="text-[11px] text-slate-500">
            {isAnyActive
              ? 'Downloads running — keep this window open.'
              : totalSize > 0 && view.size === 0
                ? <>Total: <span className="font-semibold text-slate-700">{formatBytes(totalSize)}</span></>
                : `${missing.length} model${missing.length === 1 ? '' : 's'} required`}
          </div>
          <div className="btn-group">
            <button
              type="button"
              className="btn-secondary"
              onClick={onClose}
              disabled={isAnyActive}
            >
              <X className="w-3.5 h-3.5" />
              Close
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => { onClose(); navigate('/models'); }}
            >
              <Box className="w-3.5 h-3.5" />
              Go to Models
            </button>
            {canStart && (
              <button
                type="button"
                className="btn-primary"
                onClick={handleDownloadAll}
                disabled={starting || isAnyActive}
              >
                {starting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                {starting ? 'Starting…' : (anyError ? 'Retry download' : 'Download all')}
              </button>
            )}
          </div>
        </>
      }
    >
      {gatedBlocked && (
        <div className="mb-3 flex items-start gap-2 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
          <Lock className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-600" />
          <span>
            Some models are gated and require a HuggingFace token.{' '}
            <button
              type="button"
              onClick={() => { onClose(); navigate('/settings'); }}
              className="underline font-medium hover:text-amber-900"
            >
              Add token in Settings
            </button>
            {' '}— gated models will be skipped until configured.
          </span>
        </div>
      )}

      {missing.length === 0 ? (
        <div className="empty-box">No missing dependencies.</div>
      ) : (
        <ul className="space-y-2">
          {missing.map((model) => {
            const dl = view.get(model.name);
            return (
              <li
                key={model.name}
                className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-3"
              >
                <div className="shrink-0 mt-0.5">
                  {dl?.status === 'completed' ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                  ) : dl?.status === 'error' ? (
                    <AlertCircle className="w-4 h-4 text-rose-500" />
                  ) : dl?.status === 'downloading' ? (
                    <Loader2 className="w-4 h-4 text-teal-500 animate-spin" />
                  ) : (
                    <HardDrive className="w-4 h-4 text-slate-400" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-slate-900 truncate" title={model.name}>
                      {model.name}
                    </span>
                    {model.gated && (
                      <span className="badge-pill badge-amber" title={model.gated_message || ''}>
                        <Lock className="w-3 h-3" />
                        gated
                      </span>
                    )}
                    {dl?.status === 'completed' && (
                      <span className="badge-pill badge-emerald">
                        <CheckCircle2 className="w-3 h-3" />
                        installed
                      </span>
                    )}
                    {dl?.status === 'error' && (
                      <span className="badge-pill badge-rose">
                        <AlertCircle className="w-3 h-3" />
                        error
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-[11px] text-slate-500 flex items-center gap-3 flex-wrap">
                    <span className="inline-flex items-center gap-1">
                      <FolderOpen className="w-3 h-3" />
                      {model.directory || 'unknown type'}
                    </span>
                    {(model.size_pretty || model.size) ? (
                      <span>{model.size_pretty || formatBytes(model.size!)}</span>
                    ) : null}
                  </div>
                  {model.gated && (
                    <p
                      className="mt-1 text-[11px] text-amber-700 truncate"
                      title={model.gated_message || ''}
                    >
                      {model.gated_message || 'Requires HuggingFace token (Settings)'}
                    </p>
                  )}

                  {/* Progress bar */}
                  {dl && (dl.status === 'downloading' || dl.status === 'completed') && (
                    <div className="mt-2">
                      <div className="progress-track">
                        <div
                          className={`progress-bar-fill ${dl.status === 'completed' ? '' : 'bg-teal-400'}`}
                          style={{ width: `${Math.min(100, dl.progress)}%` }}
                        />
                      </div>
                      <div className="flex justify-between mt-1">
                        <span className="text-[10px] text-slate-400">
                          {dl.status === 'completed' ? 'Complete' : `${Math.round(dl.progress)}%`}
                        </span>
                        {typeof dl.speed === 'number' && dl.speed > 0 && (
                          <span className="text-[10px] text-slate-400">
                            {formatBytes(dl.speed)}/s
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                  {dl?.status === 'error' && (
                    <div className="mt-2 flex items-start gap-2 rounded-md bg-rose-50 border border-rose-100 px-2 py-1.5 text-[11px] text-rose-700">
                      <AlertCircle className="w-3 h-3 shrink-0 mt-0.5" />
                      <span className="truncate">{dl.error}</span>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </AppModal>
  );
}
