import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle, Download, CheckCircle2, AlertCircle, Lock,
  X, Box,
  FolderOpen, HardDrive, Puzzle,
} from 'lucide-react';
import type { RequiredItem, RequiredModel, RequiredPlugin } from '../../types';
import { findDownloadForModel, isRequiredPlugin } from '../../types';
import { api } from '../../services/comfyui';
import { useApp } from '../../context/AppContext';
import AppModal from './AppModal';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Spinner } from '../ui/spinner';

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
  /** Mixed model + plugin missing items from `/api/check-dependencies`.
   *  Models render in the existing download-aware section; plugin entries
   *  render in a separate panel above with an Install button per row. */
  missing: RequiredItem[];
  /** Template name used to call `/templates/:name/install-missing-plugins`.
   *  Required for the plugin-install button to work; if absent the button
   *  is hidden so the modal still renders information-only. */
  templateName?: string;
  onClose: () => void;
  onDownloadComplete: () => void;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes === 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/** Normalised plugin key — mirrors `installMissingPluginsForTemplate`'s
 *  bookkeeping so the UI's per-plugin in-flight state lines up with the
 *  backend's per-repo task queue. */
function canonicalRepoKey(p: RequiredPlugin): string {
  const first = p.repos[0]?.repo;
  if (first) return first.toLowerCase();
  // Fall back to classType for plugins whose Manager mapping is empty —
  // those rows can't actually be installed via the bulk endpoint, but
  // the key still needs to be stable per-row.
  return p.classType.toLowerCase();
}

interface ViewState {
  status: 'pending' | 'downloading' | 'completed' | 'error';
  taskId?: string;
  progress: number;
  speed?: number;
  error?: string;
}

export default function DependencyModal({
  missing, templateName, onClose, onDownloadComplete,
}: Props) {
  const navigate = useNavigate();
  const { downloads, hfTokenConfigured } = useApp();
  // Per-model pending/error state that isn't captured by the global downloads map
  // (e.g. "starting" before the backend has assigned a taskId, or no-URL errors).
  const [localState, setLocalState] = useState<Map<string, ViewState>>(new Map());
  const [starting, setStarting] = useState(false);
  const completedFiredRef = useRef(false);

  // Split incoming items by kind so the existing model UI keeps reading
  // the same RequiredModel[] shape it did before.
  const missingPlugins: RequiredPlugin[] = useMemo(
    () => missing.filter(isRequiredPlugin),
    [missing],
  );
  const missingModels: RequiredModel[] = useMemo(
    () => missing.filter((m): m is RequiredModel => m.kind !== 'plugin'),
    [missing],
  );

  // Plugin install state per repo key. The backend queues per repo, so
  // tracking on that key keeps two class_types from the same plugin sharing
  // one row's install state.
  const [pluginInstallState, setPluginInstallState] = useState<Map<string, 'queued' | 'installed' | 'error'>>(new Map());
  const [installingPlugins, setInstallingPlugins] = useState(false);

  const totalSize = missingModels.reduce((sum, m) => sum + (m.size || 0), 0);

  // Merge local placeholders + live WS downloads (matched by name/filename) into one view.
  const view: Map<string, ViewState> = useMemo(() => {
    const m = new Map<string, ViewState>();
    for (const model of missingModels) {
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
  }, [missingModels, localState, downloads]);

  useEffect(() => {
    if (completedFiredRef.current) return;
    if (view.size !== missingModels.length) return;
    if (missingModels.length === 0) return;
    const allDone = Array.from(view.values()).every(v => v.status === 'completed');
    if (!allDone) return;
    // Plugins still pending? Don't auto-close — the user still needs to
    // resolve them.
    if (missingPlugins.some((p) => pluginInstallState.get(canonicalRepoKey(p)) !== 'installed' && !p.installed)) return;
    completedFiredRef.current = true;
    // Brief "all done" state before we fire the close-on-complete callback.
    // The cleanup clears the timer so a user-initiated close in this window
    // doesn't land onDownloadComplete on the unmounted modal.
    const id = setTimeout(onDownloadComplete, 500);
    return () => { clearTimeout(id); };
  }, [view, missingModels.length, missingPlugins, pluginInstallState, onDownloadComplete]);

  const handleDownloadAll = useCallback(async () => {
    setStarting(true);
    completedFiredRef.current = false;

    for (const model of missingModels) {
      // Skip if a download for this model is already running.
      if (findDownloadForModel(downloads, { name: model.name })) continue;
      // Whole-HF-repo entries (custom-node registry: IndexTTS2 etc.) route
      // through the hf-cli download path instead of single-URL.
      if (!model.url && !model.hfRepo) {
        setLocalState(prev => new Map(prev).set(model.name, { status: 'error', progress: 0, error: 'No download URL available' }));
        continue;
      }
      // Gated models without an HF token configured would 401 at the launcher — skip
      // and leave the gated badge visible so the user can add a token and retry.
      if (model.gated && !hfTokenConfigured) continue;
      setLocalState(prev => new Map(prev).set(model.name, { status: 'downloading', progress: 0 }));
      try {
        if (model.hfRepo) {
          await api.downloadHfRepo(model.hfRepo, model.directory, model.name);
        } else {
          await api.downloadCustomModel(model.url, model.directory || 'checkpoints', {
            modelName: model.name,
            filename: model.name,
          });
        }
        // Keep the local 'downloading' placeholder; it's overridden by the live WS state
        // inside `view` once the first progress message arrives.
      } catch (err) {
        setLocalState(prev => new Map(prev).set(model.name, { status: 'error', progress: 0, error: String(err) }));
      }
    }
    setStarting(false);
  }, [missingModels, downloads, hfTokenConfigured]);

  const isAnyActive = Array.from(view.values()).some(d => d.status === 'downloading');
  const anyError = !isAnyActive && Array.from(view.values()).some(d => d.status === 'error');
  const canStart = view.size === 0 || anyError;
  const gatedBlocked = missingModels.some(m => m.gated) && !hfTokenConfigured;

  // Fire the bulk install-missing-plugins endpoint. The backend dedups
  // per repo key + queues each repo's git clone; we mark every plugin row
  // pointing at a queued repo as 'queued' so the UI reflects in-flight
  // status until the next dependency check refresh.
  const handleInstallAllPlugins = useCallback(async () => {
    if (!templateName) return;
    setInstallingPlugins(true);
    try {
      const result = await api.installMissingPlugins(templateName);
      const updated = new Map(pluginInstallState);
      for (const q of result.queued) updated.set(q.pluginId.toLowerCase(), 'queued');
      for (const k of result.alreadyInstalled) updated.set(k.toLowerCase(), 'installed');
      for (const k of result.unknown) updated.set(k.toLowerCase(), 'error');
      setPluginInstallState(updated);
    } catch {
      // Mark every still-pending plugin as error so the user sees a signal
      // even if the API call itself failed.
      const updated = new Map(pluginInstallState);
      for (const p of missingPlugins) {
        updated.set(canonicalRepoKey(p), 'error');
      }
      setPluginInstallState(updated);
    } finally {
      setInstallingPlugins(false);
    }
  }, [templateName, missingPlugins, pluginInstallState]);

  return (
    <AppModal
      open={true}
      onClose={onClose}
      title="Missing dependencies"
      subtitle={
        isAnyActive
          ? 'Downloading required models…'
          : missingPlugins.length > 0 && missingModels.length > 0
            ? 'Workflow needs custom-node plugins AND model files before it can run.'
            : missingPlugins.length > 0
              ? 'Workflow uses nodes from custom-node plugins that aren’t installed.'
              : 'These models are referenced by the workflow but not installed.'
      }
      icon={
        <div className="rounded-md bg-warning/10 p-1.5 ring-1 ring-inset ring-warning/30">
          <AlertTriangle className="w-3.5 h-3.5 text-warning" />
        </div>
      }
      size="lg"
      disableClose={isAnyActive}
      footer={
        <>
          <div className="text-[11px] text-muted-foreground">
            {isAnyActive
              ? 'Downloads running — keep this window open.'
              : totalSize > 0 && view.size === 0
                ? <>Total: <span className="font-semibold text-foreground">{formatBytes(totalSize)}</span></>
                : (() => {
                    const parts: string[] = [];
                    if (missingPlugins.length > 0) {
                      parts.push(`${missingPlugins.length} plugin node${missingPlugins.length === 1 ? '' : 's'}`);
                    }
                    if (missingModels.length > 0) {
                      parts.push(`${missingModels.length} model${missingModels.length === 1 ? '' : 's'}`);
                    }
                    return parts.length > 0 ? `${parts.join(' + ')} required` : 'Nothing missing';
                  })()}
          </div>
          <div className="inline-flex gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={onClose}
              disabled={isAnyActive}
            >
              <X className="w-3.5 h-3.5" />
              Close
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => { onClose(); navigate('/models'); }}
            >
              <Box className="w-3.5 h-3.5" />
              Go to Models
            </Button>
            {canStart && (
              <Button
                type="button"
                onClick={handleDownloadAll}
                disabled={starting || isAnyActive}
              >
                {starting ? <Spinner size="sm" /> : <Download className="w-3.5 h-3.5" />}
                {starting ? 'Starting…' : (anyError ? 'Retry download' : 'Download all')}
              </Button>
            )}
          </div>
        </>
      }
    >
      {gatedBlocked && (
        <div className="mb-3 flex items-start gap-2 rounded-md bg-warning/10 border border-warning/30 px-3 py-2 text-xs text-warning">
          <Lock className="w-3.5 h-3.5 shrink-0 mt-0.5 text-warning" />
          <span>
            Some models are gated and require a HuggingFace token.{' '}
            <button
              type="button"
              onClick={() => { onClose(); navigate('/settings'); }}
              className="underline font-medium hover:text-warning/80"
            >
              Add token in Settings
            </button>
            {' '}— gated models will be skipped until configured.
          </span>
        </div>
      )}

      {missingPlugins.length > 0 && (
        <section className="mb-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground flex items-center gap-1.5">
              <Puzzle className="w-3.5 h-3.5 text-muted-foreground" />
              Missing plugins
              <span className="text-[10px] font-normal text-muted-foreground">
                ({missingPlugins.length} node{missingPlugins.length === 1 ? '' : 's'})
              </span>
            </h3>
            {templateName && missingPlugins.some((p) => p.repos.length > 0) && (
              <Button
                type="button"
                variant="secondary"
                onClick={handleInstallAllPlugins}
                disabled={installingPlugins}
              >
                {installingPlugins
                  ? <Spinner size="sm" />
                  : <Download className="w-3.5 h-3.5" />}
                {installingPlugins ? 'Queueing…' : 'Install all'}
              </Button>
            )}
          </div>
          <ul className="space-y-2">
            {missingPlugins.map((p) => {
              const key = canonicalRepoKey(p);
              const status = pluginInstallState.get(key);
              return (
                <li
                  key={`plugin:${p.classType}:${key}`}
                  className="card-row"
                >
                  <div className="shrink-0 mt-0.5">
                    {status === 'installed' ? (
                      <CheckCircle2 className="w-4 h-4 text-success" />
                    ) : status === 'queued' ? (
                      <Spinner size="md" className="text-muted-foreground" />
                    ) : status === 'error' ? (
                      <AlertCircle className="w-4 h-4 text-destructive" />
                    ) : (
                      <Puzzle className="w-4 h-4 text-muted-foreground" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-foreground truncate" title={p.classType}>
                        {p.classType}
                      </span>
                      {status === 'installed' && (
                        <Badge variant="emerald">
                          <CheckCircle2 className="w-3 h-3" />
                          installed
                        </Badge>
                      )}
                      {status === 'queued' && (
                        <Badge variant="amber">
                          <Spinner size="xs" />
                          installing
                        </Badge>
                      )}
                      {status === 'error' && (
                        <Badge variant="rose">
                          <AlertCircle className="w-3 h-3" />
                          error
                        </Badge>
                      )}
                    </div>
                    {p.subgraphName && (
                      <div className="mt-0.5 text-[11px] text-muted-foreground">
                        in subgraph <span className="font-medium text-foreground">'{p.subgraphName}'</span>
                      </div>
                    )}
                    {p.repos.length > 0 ? (
                      <div className="mt-1 text-[11px] text-muted-foreground">
                        Provided by{' '}
                        {p.repos.map((r, i) => (
                          <span key={r.repo} className="text-foreground">
                            {i > 0 ? ', ' : ''}{r.title || r.repo}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <div className="mt-1 text-[11px] text-warning">
                        Plugin not in any registry — install manually from the source URL.
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {missingModels.length === 0 && missingPlugins.length === 0 ? (
        <div className="empty-box">No missing dependencies.</div>
      ) : missingModels.length === 0 ? null : (
        <section>
          {missingPlugins.length > 0 && (
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground flex items-center gap-1.5">
              <HardDrive className="w-3.5 h-3.5 text-brand" />
              Missing models
              <span className="text-[10px] font-normal text-muted-foreground">
                ({missingModels.length})
              </span>
            </h3>
          )}
        <ul className="space-y-2">
          {missingModels.map((model) => {
            const dl = view.get(model.name);
            return (
              <li
                key={model.name}
                className="card-row"
              >
                <div className="shrink-0 mt-0.5">
                  {dl?.status === 'completed' ? (
                    <CheckCircle2 className="w-4 h-4 text-success" />
                  ) : dl?.status === 'error' ? (
                    <AlertCircle className="w-4 h-4 text-destructive" />
                  ) : dl?.status === 'downloading' ? (
                    <Spinner size="md" className="text-brand" />
                  ) : (
                    <HardDrive className="w-4 h-4 text-muted-foreground" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-foreground truncate" title={model.name}>
                      {model.name}
                    </span>
                    {model.gated && (
                      <Badge variant="amber" title={model.gated_message || ''}>
                        <Lock className="w-3 h-3" />
                        gated
                      </Badge>
                    )}
                    {dl?.status === 'completed' && (
                      <Badge variant="emerald">
                        <CheckCircle2 className="w-3 h-3" />
                        installed
                      </Badge>
                    )}
                    {dl?.status === 'error' && (
                      <Badge variant="rose">
                        <AlertCircle className="w-3 h-3" />
                        error
                      </Badge>
                    )}
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground flex items-center gap-3 flex-wrap">
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
                      className="mt-1 text-[11px] text-warning truncate"
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
                          className={`progress-bar-fill ${dl.status === 'completed' ? '' : 'bg-brand/70'}`}
                          style={{ width: `${Math.min(100, dl.progress)}%` }}
                        />
                      </div>
                      <div className="flex justify-between mt-1">
                        <span className="text-[10px] text-muted-foreground">
                          {dl.status === 'completed' ? 'Complete' : `${Math.round(dl.progress)}%`}
                        </span>
                        {typeof dl.speed === 'number' && dl.speed > 0 && (
                          <span className="text-[10px] text-muted-foreground">
                            {formatBytes(dl.speed)}/s
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                  {dl?.status === 'error' && (
                    <div className="mt-2 flex items-start gap-2 rounded-md bg-destructive/10 border border-destructive/30 px-2 py-1.5 text-[11px] text-destructive">
                      <AlertCircle className="w-3 h-3 shrink-0 mt-0.5" />
                      <span className="truncate">{dl.error}</span>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        </section>
      )}
    </AppModal>
  );
}
