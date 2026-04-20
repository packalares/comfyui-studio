import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Box, Trash2, Loader2, Search, WifiOff, Settings,
  Download, X, SlidersHorizontal, Lock, AlertTriangle, History,
} from 'lucide-react';
import type { LauncherModel, CatalogModel } from '../types';
import { findDownloadForModel } from '../types';
import { api } from '../services/comfyui';
import { useApp } from '../context/AppContext';
import { usePersistedState } from '../hooks/usePersistedState';
import PageSubbar from '../components/PageSubbar';
import DownloadsTab from '../components/DownloadsTab';
import { formatBytes } from '../lib/utils';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Checkbox } from '../components/ui/checkbox';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from '../components/ui/alert-dialog';

type ModelsTab = 'models' | 'downloads';

// Group models by type
function groupByType(models: CatalogModel[]): Record<string, CatalogModel[]> {
  const groups: Record<string, CatalogModel[]> = {};
  for (const m of models) {
    const type = m.type || 'other';
    if (!groups[type]) groups[type] = [];
    groups[type].push(m);
  }
  return groups;
}

const TYPE_LABELS: Record<string, string> = {
  checkpoints: 'Checkpoints',
  loras: 'LoRAs',
  vae: 'VAE',
  text_encoders: 'Text Encoders',
  upscale: 'Upscale Models',
  controlnet: 'ControlNet',
  clip: 'CLIP',
  diffusion_models: 'Diffusion Models',
  unet: 'UNet',
  other: 'Other',
};

export default function Models() {
  const { connected, templates, refreshTemplates, downloads, hfTokenConfigured } = useApp();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const urlTab = searchParams.get('tab');
  const initialTab: ModelsTab = urlTab === 'downloads' ? 'downloads' : 'models';
  const [tab, setTab] = useState<ModelsTab>(initialTab);

  // Keep URL in sync when the tab changes (and react to back/forward).
  useEffect(() => {
    const current = searchParams.get('tab');
    const desired = tab === 'downloads' ? 'downloads' : null;
    if (desired === current) return;
    const next = new URLSearchParams(searchParams);
    if (desired) next.set('tab', desired);
    else next.delete('tab');
    setSearchParams(next, { replace: true });
  }, [tab, searchParams, setSearchParams]);

  useEffect(() => {
    const fromUrl: ModelsTab = urlTab === 'downloads' ? 'downloads' : 'models';
    setTab(prev => (prev === fromUrl ? prev : fromUrl));
  }, [urlTab]);

  const [models, setModels] = useState<CatalogModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = usePersistedState('models.search', '');
  const [selectedWorkflow, setSelectedWorkflow] = usePersistedState<string>('models.workflow', '');
  const [workflowRequired, setWorkflowRequired] = useState<Set<string>>(new Set());
  const [typeFilter, setTypeFilter] = usePersistedState<Set<string>>('models.types', new Set());
  const [filtersOpen, setFiltersOpen] = usePersistedState('models.filtersOpen', false);

  const lastCompletedRef = useRef<Set<string>>(new Set());

  // Watch for completed downloads → rescan + reload models list
  useEffect(() => {
    for (const [taskId, dl] of Object.entries(downloads)) {
      if ((dl.completed || dl.status === 'completed') && !lastCompletedRef.current.has(taskId)) {
        lastCompletedRef.current.add(taskId);
        (async () => {
          try { await api.scanModels(); } catch { /* ignore */ }
          try {
            const data = await api.getModelsCatalog();
            setModels(data);
          } catch { /* ignore */ }
        })();
      }
    }
  }, [downloads]);

  // Load models from launcher
  const loadModels = useCallback(async () => {
    try {
      const data = await api.getModelsCatalog();
      setModels(data);
    } catch {
      setModels([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadModels();
    refreshTemplates();
  }, [loadModels, refreshTemplates]);

  // When workflow filter changes, check dependencies
  useEffect(() => {
    if (!selectedWorkflow) {
      setWorkflowRequired(new Set());
      return;
    }
    api.checkDependencies(selectedWorkflow)
      .then(result => {
        const names = new Set(result.required.map(r => r.name));
        setWorkflowRequired(names);
      })
      .catch(() => setWorkflowRequired(new Set()));
  }, [selectedWorkflow]);

  const handleInstall = useCallback(async (model: CatalogModel) => {
    try {
      // Resolve the correct model directory
      // save_path may be "default" (flag) or a nested dir — use type to infer when unclear
      const TYPE_TO_DIR: Record<string, string> = {
        upscale: 'upscale_models',
        upscaler: 'upscale_models',
        checkpoint: 'checkpoints',
        checkpoints: 'checkpoints',
        lora: 'loras',
        loras: 'loras',
        vae: 'vae',
        VAE: 'vae',
        TAESD: 'vae_approx',
        vae_approx: 'vae_approx',
        controlnet: 'controlnet',
        embedding: 'embeddings',
        'IP-Adapter': 'ipadapter',
        clip: 'clip',
        clip_vision: 'clip_vision',
        text_encoder: 'text_encoders',
        text_encoders: 'text_encoders',
        diffusion_model: 'diffusion_models',
        diffusion_models: 'diffusion_models',
        unet: 'unet',
      };

      const resolveDir = (m: CatalogModel): string => {
        // If save_path is an explicit dir (not "default"), use it as-is
        if (m.save_path && m.save_path !== 'default') return m.save_path;
        // Otherwise map from type
        return TYPE_TO_DIR[m.type] || m.type || 'checkpoints';
      };

      if (model.url) {
        const dir = resolveDir(model);
        await api.downloadCustomModel(model.url, dir, { modelName: model.name, filename: model.filename });
      } else {
        await api.installModel(model.name);
      }
      // Backend tracks + broadcasts; state will arrive via the `download` WS message.
    } catch (err) {
      console.error('Failed to start download:', err);
    }
  }, []);

  const [deleteTarget, setDeleteTarget] = useState<CatalogModel | null>(null);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      await api.deleteModel({ modelName: deleteTarget.name });
      try { await api.scanModels(); } catch { /* ignore */ }
      loadModels();
    } catch (err) {
      console.error('Failed to delete model:', err);
    } finally {
      setDeleteTarget(null);
    }
  }, [deleteTarget, loadModels]);

  const handleCancelDownload = useCallback(async (_modelName: string, downloadId: string) => {
    try {
      await api.cancelDownload(downloadId);
    } catch (err) {
      console.error('Failed to cancel download:', err);
    }
  }, []);

  // Unique types from all models
  const uniqueTypes = useMemo(() => {
    const types = new Set<string>();
    for (const m of models) {
      types.add(m.type || 'other');
    }
    return Array.from(types).sort();
  }, [models]);

  // Filter models
  const filteredModels = useMemo(() => {
    let filtered = models;

    // Filter by workflow if selected
    if (selectedWorkflow && workflowRequired.size > 0) {
      filtered = filtered.filter(m =>
        workflowRequired.has(m.filename) || workflowRequired.has(m.name)
      );
    }

    // Type filter
    if (typeFilter.size > 0) {
      filtered = filtered.filter(m => typeFilter.has(m.type || 'other'));
    }

    // Search filter
    if (search.trim()) {
      const q = search.toLowerCase();
      filtered = filtered.filter(m =>
        m.name.toLowerCase().includes(q) ||
        m.filename?.toLowerCase().includes(q) ||
        m.type?.toLowerCase().includes(q)
      );
    }

    return filtered;
  }, [models, selectedWorkflow, workflowRequired, search, typeFilter]);

  const grouped = useMemo(() => groupByType(filteredModels), [filteredModels]);

  const handleDownloadAllMissing = useCallback(async () => {
    const missingModels = filteredModels.filter(m => !m.installed);
    for (const model of missingModels) {
      await handleInstall(model);
    }
  }, [filteredModels, handleInstall]);

  const toggleTypeFilter = useCallback((type: string) => {
    setTypeFilter(prev => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  }, []);

  const clearFilters = useCallback(() => {
    setSearch('');
    setSelectedWorkflow('');
    setTypeFilter(new Set());
  }, []);

  const installedCount = models.filter(m => m.installed).length;
  const totalDiskSize = models
    .filter(m => m.installed)
    .reduce((sum, m) => sum + (m.fileSize || 0), 0);
  const missingInFilter = selectedWorkflow
    ? filteredModels.filter(m => !m.installed).length
    : 0;

  const getDownloadForModel = (model: CatalogModel) => {
    const dl = findDownloadForModel(downloads, { name: model.name, filename: model.filename });
    if (!dl) return undefined;
    return { modelName: model.name, downloadId: dl.taskId, progress: dl.progress, status: dl.status };
  };

  const subbarDescription =
    tab === 'downloads'
      ? 'Download history'
      : `${models.length} total, ${installedCount} installed`;

  return (
    <>
      <PageSubbar
        title="Models"
        description={subbarDescription}
        right={
          tab === 'models' ? (
            <button
              onClick={() => setFiltersOpen(o => !o)}
              className="btn-secondary lg:hidden"
              aria-label="Toggle filters"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              Filters
            </button>
          ) : null
        }
      />
      <div className="page-container">
        {/* Tab strip */}
        <div
          role="tablist"
          aria-label="Models sections"
          className="mb-3 inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-1 shadow-sm"
        >
          <button
            role="tab"
            aria-selected={tab === 'models'}
            onClick={() => setTab('models')}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-semibold transition ${
              tab === 'models'
                ? 'bg-slate-900 text-white'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <Box className="w-3.5 h-3.5" />
            Models
          </button>
          <button
            role="tab"
            aria-selected={tab === 'downloads'}
            onClick={() => setTab('downloads')}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-semibold transition ${
              tab === 'downloads'
                ? 'bg-slate-900 text-white'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <History className="w-3.5 h-3.5" />
            Downloads
          </button>
        </div>

        {tab === 'downloads' ? (
          <DownloadsTab />
        ) : loading ? (
          <div className="flex items-center justify-center h-64">
            <Loader2 className="w-6 h-6 text-gray-400 animate-spin" />
          </div>
        ) : (
        <div className="panel">
          <div className="flex flex-col lg:flex-row min-h-[calc(100vh-180px)] relative">
            {/* ===== Left sidebar ===== */}
            <aside className={`${filtersOpen ? 'block' : 'hidden'} lg:block w-full lg:w-72 shrink-0 border-b lg:border-b-0 lg:border-r border-slate-200 p-4 space-y-5 bg-white`}>
              {/* Workflow filter */}
              <div>
                <label className="field-label mb-1.5 block">Filter by workflow</label>
                <Select
                  value={selectedWorkflow || 'all'}
                  onValueChange={(v) => setSelectedWorkflow(v === 'all' ? '' : v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="All Models" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Models</SelectItem>
                    {templates.filter(t => t.openSource === true).map(t => (
                      <SelectItem key={t.name} value={t.name}>{t.title}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Search */}
              <div>
                <label className="field-label mb-1.5 block">Search</label>
                <div className="field-wrap">
                  <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                  <input
                    type="text"
                    className="field-input"
                    placeholder="Search models..."
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                  />
                </div>
              </div>

              {/* Type filter */}
              {uniqueTypes.length > 0 && (
                <div>
                  <label className="field-label mb-1.5 block">Types</label>
                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {uniqueTypes.map(type => (
                      <label
                        key={type}
                        className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer select-none hover:text-slate-900"
                      >
                        <Checkbox
                          checked={typeFilter.has(type)}
                          onCheckedChange={() => toggleTypeFilter(type)}
                        />
                        {TYPE_LABELS[type] || type}
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {/* Storage Summary */}
              <div className="pt-4 border-t border-slate-200">
                <label className="field-label mb-3 block">Storage</label>
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-md bg-emerald-50 ring-1 ring-inset ring-emerald-100 px-3 py-2">
                    <p className="text-[10px] font-medium uppercase tracking-wide text-emerald-700/70">Installed</p>
                    <p className="text-lg font-bold text-emerald-700 leading-tight mt-0.5">{installedCount}</p>
                  </div>
                  <div className="rounded-md bg-slate-50 ring-1 ring-inset ring-slate-200 px-3 py-2">
                    <p className="text-[10px] font-medium uppercase tracking-wide text-slate-500">Available</p>
                    <p className="text-lg font-bold text-slate-700 leading-tight mt-0.5">{models.length}</p>
                  </div>
                  <div className="col-span-2 rounded-md bg-gradient-to-br from-teal-50 to-slate-50 ring-1 ring-inset ring-teal-100 px-3 py-2">
                    <p className="text-[10px] font-medium uppercase tracking-wide text-teal-700/70">Disk Usage</p>
                    <p className="text-sm font-semibold text-teal-700 leading-tight mt-0.5 font-mono">{formatBytes(totalDiskSize)}</p>
                  </div>
                </div>
              </div>
            </aside>

            {/* ===== Right content ===== */}
            <main className="flex-1 p-4 overflow-y-auto">
              {/* Download All Missing banner */}
              {selectedWorkflow && missingInFilter > 0 && (
                <div className="flex items-center justify-between p-3 bg-amber-50 border border-amber-200 rounded-lg mb-4">
                  <span className="text-sm text-amber-800">
                    <strong>{missingInFilter}</strong> models required by{' '}
                    {templates.find(t => t.name === selectedWorkflow)?.title || selectedWorkflow} are not installed
                  </span>
                  <button onClick={handleDownloadAllMissing} className="btn-primary">
                    <Download className="w-3.5 h-3.5" />
                    Download All Missing ({missingInFilter})
                  </button>
                </div>
              )}

              {/* Models list */}
              {Object.keys(grouped).length > 0 ? (
                <div className="space-y-3">
                  {Object.entries(grouped).map(([type, typeModels]) => {
                    const installedCountInType = typeModels.filter(m => m.installed).length;
                    return (
                      <section key={type} className="panel">
                        <div className="panel-header flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2">
                            <Box className="w-3.5 h-3.5 text-slate-400" />
                            <h2 className="panel-header-title">{TYPE_LABELS[type] || type}</h2>
                          </div>
                          <span className="badge-pill badge-slate">
                            {installedCountInType}/{typeModels.length} installed
                          </span>
                        </div>
                        <div className="divide-y divide-slate-100 max-h-[360px] overflow-y-auto scrollbar-subtle">
                          {typeModels.map((model, i) => {
                            const dl = getDownloadForModel(model);
                            const isRequired = workflowRequired.has(model.filename) || workflowRequired.has(model.name);
                            return (
                              <div
                                key={`${model.name}-${i}`}
                                className="flex items-center gap-3 py-2.5 px-4 hover:bg-slate-50"
                              >
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm font-medium text-slate-900 truncate">
                                    {model.filename || model.name}
                                  </p>
                                  <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                                    {model.fileSize ? (
                                      <span className="text-[11px] text-slate-500">{formatBytes(model.fileSize)}</span>
                                    ) : model.size_bytes ? (
                                      <span className="text-[11px] text-slate-500">{model.size_pretty || formatBytes(model.size_bytes)}</span>
                                    ) : null}
                                    {model.installed && model.fileStatus !== 'corrupt' && model.fileStatus !== 'incomplete' ? (
                                      <span className="badge-pill badge-emerald">Installed</span>
                                    ) : model.fileStatus === 'corrupt' ? (
                                      <span
                                        className="badge-pill bg-red-50 text-red-700 ring-red-200 inline-flex items-center gap-1"
                                        title={`On disk: ${formatBytes(model.fileSize || 0)} — expected ${model.size_pretty || formatBytes(model.size_bytes)}`}
                                      >
                                        <AlertTriangle className="w-3 h-3" /> Corrupt
                                      </span>
                                    ) : model.fileStatus === 'incomplete' ? (
                                      <span
                                        className="badge-pill bg-amber-50 text-amber-700 ring-amber-200 inline-flex items-center gap-1"
                                        title={`On disk: ${formatBytes(model.fileSize || 0)} — expected ${model.size_pretty || formatBytes(model.size_bytes)}`}
                                      >
                                        <AlertTriangle className="w-3 h-3" /> Incomplete
                                      </span>
                                    ) : (
                                      <span className="text-[11px] text-slate-400">Not installed</span>
                                    )}
                                    {model.gated && (
                                      <span
                                        className="badge-pill bg-slate-100 text-slate-700 ring-slate-300 inline-flex items-center gap-1"
                                        title={model.gated_message || 'Requires HuggingFace token'}
                                      >
                                        <Lock className="w-3 h-3" /> Gated
                                      </span>
                                    )}
                                    {isRequired && selectedWorkflow && (
                                      <span className="badge-pill badge-amber">Required</span>
                                    )}
                                  </div>
                                </div>
                                <div className="shrink-0">
                                  {dl && dl.status === 'queued' ? (
                                    <span className="badge-pill bg-slate-100 text-slate-600 ring-slate-200 inline-flex items-center gap-1">
                                      <Loader2 className="w-3 h-3 animate-spin" /> Queued
                                    </span>
                                  ) : dl ? (
                                    <div className="flex items-center gap-2">
                                      <div className="w-24">
                                        <div className="flex justify-between text-[10px] text-slate-500 mb-0.5">
                                          <span>{Math.round(dl.progress)}%</span>
                                        </div>
                                        <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                                          <div
                                            className="h-full bg-teal-500 rounded-full transition-all duration-300"
                                            style={{ width: `${dl.progress}%` }}
                                          />
                                        </div>
                                      </div>
                                      <button
                                        onClick={() => handleCancelDownload(model.name, dl.downloadId)}
                                        className="btn-icon"
                                        title="Cancel download"
                                      >
                                        <X className="w-4 h-4" />
                                      </button>
                                    </div>
                                  ) : model.installed ? (
                                    <button
                                      onClick={() => setDeleteTarget(model)}
                                      className="btn-icon hover:!text-red-500"
                                      title="Delete model"
                                    >
                                      <Trash2 className="w-4 h-4" />
                                    </button>
                                  ) : model.gated && !hfTokenConfigured ? (
                                    <button
                                      onClick={() => navigate('/settings')}
                                      className="btn-secondary"
                                      title={model.gated_message || 'Requires HuggingFace token — click to configure'}
                                    >
                                      <Lock className="w-3.5 h-3.5" />
                                      HF token
                                    </button>
                                  ) : (
                                    <button
                                      onClick={() => handleInstall(model)}
                                      className="btn-primary"
                                    >
                                      <Download className="w-3.5 h-3.5" />
                                      Download
                                    </button>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </section>
                    );
                  })}
                </div>
              ) : (
                <div className="text-center py-16">
                  {!connected ? (
                    <>
                      <WifiOff className="w-10 h-10 text-slate-200 mx-auto mb-3" />
                      <p className="text-sm font-medium text-slate-500">Connect to ComfyUI to manage models</p>
                      <p className="text-xs text-slate-400 mt-1 mb-4">Models will appear once the connection is established</p>
                      <button
                        onClick={() => navigate('/settings')}
                        className="btn-secondary"
                      >
                        <Settings className="w-3.5 h-3.5" />
                        Check Settings
                      </button>
                    </>
                  ) : models.length === 0 ? (
                    <>
                      <Box className="w-10 h-10 text-slate-200 mx-auto mb-3" />
                      <p className="text-sm font-medium text-slate-500">No models found</p>
                      <p className="text-xs text-slate-400 mt-1">The launcher may not be available</p>
                    </>
                  ) : (
                    <>
                      <Box className="w-10 h-10 text-slate-200 mx-auto mb-3" />
                      <p className="text-sm text-slate-500">No models match your filters</p>
                      <button
                        onClick={clearFilters}
                        className="text-xs text-teal-600 hover:text-teal-700 mt-2"
                      >
                        Clear filters
                      </button>
                    </>
                  )}
                </div>
              )}
            </main>
          </div>
        </div>
        )}
      </div>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete model?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete <span className="font-mono text-slate-700">{deleteTarget?.filename || deleteTarget?.name}</span> from disk. You can re-download it later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} className="!bg-red-600 hover:!bg-red-700">
              <Trash2 className="w-3.5 h-3.5" />
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
