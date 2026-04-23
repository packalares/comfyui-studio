import React, { createContext, useContext, useEffect, useCallback, useMemo } from 'react';
import type {
  Template,
  SystemStats,
  QueueStatus,
  GalleryItem,
  AppSettings,
  GenerationJob,
  LauncherStatus,
  MonitorStats,
  DownloadState,
} from '../types';
import { toast } from 'sonner';
import { api } from '../services/comfyui';
import { SystemProvider, useSystem } from './SystemContext';
import { CatalogProvider, useCatalog } from './CatalogContext';
import { JobsProvider, useJobs, type LiveProgress } from './JobsContext';
import { SettingsProvider, useSettings } from './SettingsContext';

export { useSystem } from './SystemContext';
export { useCatalog } from './CatalogContext';
export { useJobs } from './JobsContext';
export { useSettings } from './SettingsContext';

interface AppContextType {
  templates: Template[];
  systemStats: SystemStats | null;
  monitorStats: MonitorStats | null;
  queueStatus: QueueStatus;
  gallery: GalleryItem[];
  galleryTotal: number;
  recentGallery: GalleryItem[];
  settings: AppSettings;
  currentJob: GenerationJob | null;
  connected: boolean;
  loading: boolean;
  launcherStatus: LauncherStatus | null;
  apiKeyConfigured: boolean;
  hfTokenConfigured: boolean;
  civitaiTokenConfigured: boolean;
  pexelsApiKeyConfigured: boolean;
  uploadMaxBytes: number;
  downloads: Record<string, DownloadState>;
  progress: LiveProgress | null;
  activePromptId: string | null;
  refreshTemplates: () => Promise<void>;
  refreshSystem: () => Promise<void>;
  refreshGallery: () => Promise<void>;
  updateSettings: (settings: Partial<AppSettings>) => void;
  submitGeneration: (
    templateName: string,
    inputs: Record<string, unknown>,
    advancedSettings?: Record<string, { proxyIndex: number; value: unknown }>,
  ) => Promise<void>;
  cancelRunning: () => Promise<void>;
  cancelPending: (promptId: string) => Promise<void>;
  setCurrentJob: React.Dispatch<React.SetStateAction<GenerationJob | null>>;
}

const AppContext = createContext<AppContextType | null>(null);

/**
 * WsAndFacadeProvider — mounted inside all four slice providers.
 *
 * Owns:
 *  - the single WebSocket connection
 *  - the unified `refreshSystem` (which hits /api/system and fans the payload
 *    out across System + Catalog + Jobs slices)
 *  - the façade value returned by `useApp()`
 */
function WsAndFacadeProvider({ children }: { children: React.ReactNode }) {
  const system = useSystem();
  const catalog = useCatalog();
  const jobs = useJobs();
  const settings = useSettings();

  const {
    _setConnected,
    _setMonitorStats,
    _setSystemStats,
    _setLauncherStatus,
    _setApiKeyConfigured,
    _setHfTokenConfigured,
    _setCivitaiTokenConfigured,
    _setPexelsApiKeyConfigured,
    _setUploadMaxBytes,
    _systemStatsRef,
  } = system;
  const { _setGalleryTotal, _setRecentGallery } = catalog;
  const {
    _setQueueStatus,
    _setDownloads,
    _setProgress,
    _setActivePromptId,
    _activePromptIdRef,
    _fetchOutputFromHistory,
    setCurrentJob,
  } = jobs;

  // Unified system refresh — populates System, Catalog (gallery), and Jobs (queue) slices.
  const refreshSystem = useCallback(async () => {
    try {
      const data = await api.getSystemStats();
      const {
        queue, gallery: galleryInfo,
        apiKeyConfigured, hfTokenConfigured, civitaiTokenConfigured,
        pexelsApiKeyConfigured,
        uploadMaxBytes,
        ...stats
      } = data;
      _setSystemStats(stats);
      _systemStatsRef.current = stats;
      if (queue) _setQueueStatus(queue);
      if (galleryInfo) {
        _setGalleryTotal(galleryInfo.total);
        _setRecentGallery(galleryInfo.recent);
      }
      if (typeof apiKeyConfigured === 'boolean') _setApiKeyConfigured(apiKeyConfigured);
      if (typeof hfTokenConfigured === 'boolean') _setHfTokenConfigured(hfTokenConfigured);
      if (typeof civitaiTokenConfigured === 'boolean') _setCivitaiTokenConfigured(civitaiTokenConfigured);
      if (typeof pexelsApiKeyConfigured === 'boolean') _setPexelsApiKeyConfigured(pexelsApiKeyConfigured);
      if (typeof uploadMaxBytes === 'number' && Number.isFinite(uploadMaxBytes)) {
        _setUploadMaxBytes(uploadMaxBytes);
      }
      _setConnected(true);
    } catch (err) {
      console.error('Failed to fetch system stats:', err);
    }
  }, [
    _setSystemStats,
    _systemStatsRef,
    _setQueueStatus,
    _setGalleryTotal,
    _setRecentGallery,
    _setApiKeyConfigured,
    _setHfTokenConfigured,
    _setCivitaiTokenConfigured,
    _setPexelsApiKeyConfigured,
    _setUploadMaxBytes,
    _setConnected,
  ]);

  // Kick off the initial system fetch; individual slice providers already handle
  // their own token-status fetches.
  useEffect(() => {
    refreshSystem().finally(() => system._setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // WebSocket — owns routing of every WS message to the correct slice setter.
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    // Every setTimeout scheduled by this effect goes through scheduleTimer so
    // the cleanup can clear them on unmount. Without this, timers that fire
    // after unmount call state setters on a dead tree (React logs a warning)
    // and — more critically — re-trigger fetchOutputFromHistory / reconnect
    // work on a component that has already gone away.
    const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
    const scheduleTimer = (fn: () => void, ms: number): void => {
      const id = setTimeout(() => {
        pendingTimers.delete(id);
        fn();
      }, ms);
      pendingTimers.add(id);
    };

    const connectWs = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

      ws.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        try {
          const msg = JSON.parse(event.data);
          const promptId = _activePromptIdRef.current;

          if (msg.type === 'progress' && msg.data?.value !== undefined && msg.data?.max !== undefined) {
            const progress = (msg.data.value / msg.data.max) * 100;
            const pid = typeof msg.data?.prompt_id === 'string' ? msg.data.prompt_id : promptId;
            const nodeId = typeof msg.data?.node === 'string' ? msg.data.node : '';
            _setProgress({
              nodeId,
              value: Number(msg.data.value),
              max: Number(msg.data.max),
              promptId: pid ?? null,
            });
            if (pid) _setActivePromptId(pid);
            setCurrentJob(prev => {
              // Don't clobber terminal states. ComfyUI occasionally emits a
              // trailing `progress` event during its cleanup unwind after
              // `execution_error`; without the `failed` guard that flip
              // would revive the job to `running` and the Studio main
              // pane would show "Generating 0%" forever instead of the
              // red error panel.
              if (!prev || prev.status === 'completed' || prev.status === 'failed') return prev;
              return { ...prev, status: 'running', progress };
            });
          } else if (msg.type === 'execution_start') {
            const pid = msg.data?.prompt_id;
            if (typeof pid === 'string' && pid.length > 0) {
              _setActivePromptId(pid);
            }
          } else if (msg.type === 'executing' && msg.data?.node === null) {
            // node === null signals "all nodes for this prompt are done".
            _setProgress(null);
            _setActivePromptId(null);
            if (promptId) {
              scheduleTimer(() => _fetchOutputFromHistory(promptId), 500);
            }
          } else if (msg.type === 'executing' && typeof msg.data?.prompt_id === 'string') {
            _setActivePromptId(msg.data.prompt_id);
          } else if (msg.type === 'executed' && msg.data?.prompt_id === promptId) {
            if (promptId) {
              scheduleTimer(() => _fetchOutputFromHistory(promptId), 500);
            }
          } else if (msg.type === 'progress_state') {
            // Use the prompt_id carried by the message first — by the time
            // the final `progress_state` arrives, another branch may have
            // already cleared `_activePromptIdRef` (execution_success
            // handler does this unconditionally). For workflows where
            // `progress_state` is the ONLY terminal event (IndexTTS2 and
            // other non-sampler custom nodes that don't emit the legacy
            // events), missing this fallback leaves the card stuck with
            // no output fetch ever firing.
            const nodes = msg.data?.nodes;
            const pid = (typeof msg.data?.prompt_id === 'string' ? msg.data.prompt_id : null)
              ?? promptId;
            if (nodes && pid) {
              const allFinished = Object.values(nodes).every((n: unknown) => (n as Record<string, string>).state === 'finished');
              if (allFinished) {
                scheduleTimer(() => _fetchOutputFromHistory(pid), 500);
              }
            }
          } else if (msg.type === 'execution_success' || msg.type === 'execution_complete') {
            // Terminal states — always clear live progress + active prompt.
            // The older match-on-promptId gate missed cases where the ref
            // had fallen out of sync with the setter (ref is only updated
            // by JobsContext's own submit path, not by our WS handler), so
            // the card could hang at 100% forever. We clear unconditionally
            // and let the next `executing`/`progress` burst re-hydrate.
            _setProgress(null);
            _setActivePromptId(null);
            const donePid =
              typeof msg.data?.prompt_id === 'string' ? msg.data.prompt_id : promptId;
            if (donePid) {
              scheduleTimer(() => _fetchOutputFromHistory(donePid), 500);
            }
          } else if (msg.type === 'error' || msg.type === 'execution_error' || msg.type === 'execution_interrupted') {
            // ComfyUI's V3 error shape varies: classic `execution_error`
            // carries `exception_message`, V3 runtime errors sometimes
            // land under `error` or `message`. Fall through so the toast
            // doesn't render blank.
            const data = msg.data as {
              prompt_id?: string;
              exception_message?: string;
              error?: string;
              message?: string;
              exception_type?: string;
              node_type?: string;
            } | undefined;
            // Ignore delayed errors that belong to a prompt the user has
            // already moved past (fast-resubmit after a failure). Without
            // this gate the new job flips to `failed` the instant a stale
            // error event lands and the progress handler then refuses to
            // re-run it (the `failed` guard at the top of the progress
            // branch preserves the state). Fall through when either pid
            // is missing so we never miss a real failure.
            const errorPid =
              typeof data?.prompt_id === 'string' ? data.prompt_id : null;
            if (errorPid && promptId && errorPid !== promptId) {
              return;
            }
            const errMsg =
              data?.exception_message || data?.error || data?.message || 'ComfyUI aborted the run';
            const title = msg.type === 'execution_interrupted'
              ? 'Generation interrupted'
              : 'Generation failed';
            const description = data?.node_type
              ? `${data.node_type}: ${errMsg}`
              : errMsg;
            _setProgress(null);
            _setActivePromptId(null);
            setCurrentJob(prev => prev ? { ...prev, status: 'failed', error: errMsg } : null);
            // Toast is belt-and-suspenders: even if subsequent WS events
            // briefly flip the status back to running, the toast has
            // already surfaced the error so the user knows something went
            // wrong rather than staring at "Generating… 0%" forever.
            toast.error(title, { description });
          } else if (msg.type === 'launcher-status') {
            const status = msg.data as LauncherStatus;
            _setLauncherStatus(status);
            _setConnected(status.running === true);
            if (status.running && !_systemStatsRef.current) {
              refreshSystem();
            }
          } else if (msg.type === 'queue') {
            const q = msg.data as QueueStatus;
            _setQueueStatus(q);
            // Belt-and-suspenders for the running-task card: if ComfyUI says
            // the queue is fully idle, there's definitionally nothing to
            // track. Clear progress + activePromptId so the card hides even
            // when we miss the terminal `execution_success`/`executing`-
            // with-node:null events.
            if ((q?.queue_running ?? 0) === 0 && (q?.queue_pending ?? 0) === 0) {
              _setProgress(null);
              _setActivePromptId(null);
            }
          } else if (msg.type === 'gallery') {
            const data = msg.data as { total: number; recent: GalleryItem[] };
            _setGalleryTotal(data.total);
            _setRecentGallery(data.recent);
          } else if (msg.type === 'download') {
            const d = msg.data as DownloadState;
            _setDownloads(prev => {
              // Remove from map shortly after terminal state so completed/cancelled items don't linger.
              if (d.completed || d.status === 'completed' || d.status === 'error') {
                // Keep the terminal state visible briefly so the UI can render "done" — purge after 3s.
                scheduleTimer(() => {
                  _setDownloads(p => {
                    const { [d.taskId]: _removed, ...rest } = p;
                    return rest;
                  });
                }, 3000);
              }
              // Placeholder dedup: when a real `downloading` event arrives
              // for the same (modelName, filename) under a new taskId, drop
              // any stale queued placeholder. Otherwise the synth entry sits
              // in the map forever and findDownloadForModel picks it up
              // before the real live entry.
              const next: Record<string, DownloadState> = {};
              if (d.status === 'downloading') {
                for (const [k, v] of Object.entries(prev)) {
                  if (k === d.taskId) continue;
                  const sameModel =
                    (v.filename && v.filename === d.filename) ||
                    (v.modelName && v.modelName === d.modelName);
                  if (sameModel && v.status !== 'downloading') continue; // drop it
                  next[k] = v;
                }
              } else {
                Object.assign(next, prev);
              }
              next[d.taskId] = d;
              return next;
            });
          } else if (msg.type === 'downloads-snapshot') {
            const list = msg.data as DownloadState[];
            _setDownloads(Object.fromEntries(list.map(d => [d.taskId, d])));
          } else if (msg.type === 'crystools.monitor') {
            const d = msg.data as {
              cpu_utilization?: number;
              ram_total?: number;
              ram_used?: number;
              ram_used_percent?: number;
              hdd_total?: number;
              hdd_used?: number;
              hdd_used_percent?: number;
              device_type?: string;
              gpus?: Array<{
                gpu_utilization?: number;
                gpu_temperature?: number;
                vram_total?: number;
                vram_used?: number;
              }>;
            };
            _setConnected(true);
            _setMonitorStats({
              cpu_utilization: d.cpu_utilization,
              ram_total: d.ram_total,
              ram_used: d.ram_used,
              ram_used_percent: d.ram_used_percent,
              hdd_total: d.hdd_total,
              hdd_used: d.hdd_used,
              hdd_used_percent: d.hdd_used_percent,
              device_type: d.device_type,
            });
            _setSystemStats(prev => {
              if (!prev) return prev;
              const next = {
                ...prev,
                devices: prev.devices.map((dev, i) => {
                  const g = d.gpus?.[i];
                  if (!g) return dev;
                  return {
                    ...dev,
                    vram_used: g.vram_used ?? dev.vram_used,
                    vram_total: g.vram_total ?? dev.vram_total,
                    temperature: g.gpu_temperature ?? dev.temperature,
                    utilization: g.gpu_utilization ?? dev.utilization,
                  };
                }),
              };
              _systemStatsRef.current = next;
              return next;
            });
            if (!_systemStatsRef.current) refreshSystem();
          }
        } catch {
          // ignore non-JSON messages
        }
      };

      ws.onclose = () => {
        if (closed) return;
        scheduleTimer(connectWs, 3000);
      };
    };

    connectWs();
    return () => {
      closed = true;
      for (const id of pendingTimers) clearTimeout(id);
      pendingTimers.clear();
      ws?.close();
    };
  }, [
    refreshSystem,
    _fetchOutputFromHistory,
    setCurrentJob,
    _setLauncherStatus,
    _setConnected,
    _setQueueStatus,
    _setGalleryTotal,
    _setRecentGallery,
    _setDownloads,
    _setProgress,
    _setActivePromptId,
    _setMonitorStats,
    _setSystemStats,
    _systemStatsRef,
    _activePromptIdRef,
  ]);

  const value = useMemo<AppContextType>(
    () => ({
      templates: catalog.templates,
      systemStats: system.systemStats,
      monitorStats: system.monitorStats,
      queueStatus: jobs.queueStatus,
      gallery: catalog.gallery,
      galleryTotal: catalog.galleryTotal,
      recentGallery: catalog.recentGallery,
      settings: settings.settings,
      currentJob: jobs.currentJob,
      connected: system.connected,
      loading: system.loading,
      launcherStatus: system.launcherStatus,
      apiKeyConfigured: system.apiKeyConfigured,
      hfTokenConfigured: system.hfTokenConfigured,
      civitaiTokenConfigured: system.civitaiTokenConfigured,
      pexelsApiKeyConfigured: system.pexelsApiKeyConfigured,
      uploadMaxBytes: system.uploadMaxBytes,
      downloads: jobs.downloads,
      progress: jobs.progress,
      activePromptId: jobs.activePromptId,
      refreshTemplates: catalog.refreshTemplates,
      refreshSystem,
      refreshGallery: catalog.refreshGallery,
      updateSettings: settings.updateSettings,
      submitGeneration: jobs.submitGeneration,
      cancelRunning: jobs.cancelRunning,
      cancelPending: jobs.cancelPending,
      setCurrentJob: jobs.setCurrentJob,
    }),
    [
      catalog.templates,
      catalog.gallery,
      catalog.galleryTotal,
      catalog.recentGallery,
      catalog.refreshTemplates,
      catalog.refreshGallery,
      system.systemStats,
      system.monitorStats,
      system.connected,
      system.loading,
      system.launcherStatus,
      system.apiKeyConfigured,
      system.hfTokenConfigured,
      system.civitaiTokenConfigured,
      system.pexelsApiKeyConfigured,
      system.uploadMaxBytes,
      jobs.queueStatus,
      jobs.currentJob,
      jobs.downloads,
      jobs.progress,
      jobs.activePromptId,
      jobs.submitGeneration,
      jobs.cancelRunning,
      jobs.cancelPending,
      jobs.setCurrentJob,
      settings.settings,
      settings.updateSettings,
      refreshSystem,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  return (
    <SettingsProvider>
      <SystemProvider>
        <CatalogProvider>
          <JobsProvider>
            <WsAndFacadeProvider>{children}</WsAndFacadeProvider>
          </JobsProvider>
        </CatalogProvider>
      </SystemProvider>
    </SettingsProvider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
