import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Box, Trash2, Loader2, Search, WifiOff, Settings,
  Download, SlidersHorizontal, History, X, HardDrive, CheckCircle2, Package,
} from 'lucide-react';
import type { CatalogModel, CivitaiModelSummary } from '../types';
import { findDownloadForModel } from '../types';
import { api } from '../services/comfyui';
import { useApp } from '../context/AppContext';
import { usePersistedState } from '../hooks/usePersistedState';
import { usePaginated } from '../hooks/usePaginated';
import PageSubbar from '../components/PageSubbar';
import DownloadsTab from '../components/DownloadsTab';
import ModelRow, { type ModelRowDownload, type ModelRowItem } from '../components/ModelRow';
import ModelInfoModal, { type ModelInfoSource } from '../components/ModelInfoModal';
import { formatBytes } from '../lib/utils';
import { imgProxy } from '../lib/imgProxy';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Combobox, COMBOBOX_SEARCH_THRESHOLD } from '../components/ui/combobox';
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

  const [search, setSearch] = usePersistedState('models.search', '');
  // Debounced mirror of `search` used for the actual fetch — without this,
  // every keystroke triggered a fresh civitai round-trip + image swap.
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 350);
    return () => clearTimeout(t);
  }, [search]);
  const [selectedWorkflow, setSelectedWorkflow] = usePersistedState<string>('models.workflow', '');
  const [workflowRequired, setWorkflowRequired] = useState<Set<string>>(new Set());
  const [typeFilter, setTypeFilter] = usePersistedState<Set<string>>('models.types', new Set());
  const [installedFilter, setInstalledFilter] = usePersistedState<'all' | 'yes' | 'no'>('models.installed', 'all');
  const [filtersOpen, setFiltersOpen] = usePersistedState('models.filtersOpen', false);
  // Source: local catalog vs. CivitAI. Can be primed from `?source=civitai`
  // (used by the legacy /plugins/civitai/models redirect).
  type ModelSource = 'local' | 'civitai';
  const urlSource = searchParams.get('source');
  const [source, setSource] = usePersistedState<ModelSource>(
    'models.source',
    urlSource === 'civitai' ? 'civitai' : 'local',
  );
  useEffect(() => {
    if (urlSource === 'civitai' && source !== 'civitai') setSource('civitai');
    // URL → state sync is one-way; we don't want the source to ping-pong.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlSource]);

  // Full catalog loaded once for stats + type-list + workflow dep filter. The
  // displayed list is server-paginated below. Models.types is bounded (~50
  // types max), so the overhead is acceptable.
  const [allModels, setAllModels] = useState<CatalogModel[]>([]);
  const lastCompletedRef = useRef<Set<string>>(new Set());

  const loadAllModels = useCallback(async () => {
    try {
      const data = await api.getModelsCatalog();
      setAllModels(data);
    } catch {
      setAllModels([]);
    }
  }, []);

  useEffect(() => {
    loadAllModels();
    refreshTemplates();
  }, [loadAllModels, refreshTemplates]);

  // Watch for completed downloads → rescan + reload full catalog + current page.
  // `refetchPage` is pulled from the `paged` memo below; set after it's defined.
  const refetchPageRef = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => {
    for (const [taskId, dl] of Object.entries(downloads)) {
      if ((dl.completed || dl.status === 'completed') && !lastCompletedRef.current.has(taskId)) {
        lastCompletedRef.current.add(taskId);
        (async () => {
          try { await api.scanModels(); } catch { /* ignore */ }
          await loadAllModels();
          // Explicitly refetch the visible page once so newly-installed
          // rows reflect their `installed` flag. Avoids the loopy
          // `useEffect(() => refetchPage(), [allModels])` that fired on
          // every mount + catalog change.
          await refetchPageRef.current?.();
        })();
      }
    }
  }, [downloads, loadAllModels]);

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

  // Server-paginated fetch for the visible list. Filters are forwarded so
  // pagination lines up across pages.
  const types = useMemo(() => Array.from(typeFilter), [typeFilter]);
  const installedParam: boolean | null = installedFilter === 'yes' ? true : installedFilter === 'no' ? false : null;

  // A shared row type covers both local catalog items + civitai search results
  // so `usePaginated` / the grid stay single-fetcher. Local rows carry a
  // CatalogModel; remote rows carry a CivitaiModelSummary.
  type PageRow =
    | { kind: 'catalog'; model: CatalogModel }
    | { kind: 'civitai'; item: CivitaiModelSummary };

  const fetcher = useCallback(
    async ({ page, pageSize }: { page: number; pageSize: number }) => {
      if (source === 'civitai') {
        const trimmed = debouncedSearch.trim();
        // Mirror CivitaiModelsView: search when the query is non-empty;
        // otherwise page the "hot" sort as a sensible default.
        const res = trimmed
          ? await api.searchCivitaiModels(trimmed, { page, pageSize })
          : await api.getCivitaiHotModels({ page, pageSize });
        return {
          items: res.items.map<PageRow>((item) => ({ kind: 'civitai', item })),
          total: res.total,
          // CivitAI search doesn't support page-based pagination; the service
          // surfaces that by setting hasMore=false on search responses.
          hasMore: res.hasMore,
        };
      }
      const res = await api.getModelsCatalogPaged(page, pageSize, {
        q: debouncedSearch.trim() || undefined,
        types: types.length > 0 ? types : undefined,
        installed: installedParam,
      });
      return {
        items: res.items.map<PageRow>((model) => ({ kind: 'catalog', model })),
        total: res.total,
        hasMore: res.hasMore,
      };
    },
    [source, debouncedSearch, types, installedParam],
  );
  const paged = usePaginated<PageRow>(fetcher, {
    deps: [source, debouncedSearch, types, installedParam],
  });
  const { items: pageItems, loading, refetch: refetchPage } = paged;

  // "Load more" accumulator. `usePaginated` replaces `items` on every page
  // change; the Models page wants cumulative rows across pages (CivitAI +
  // local), so we keep a separate append-only list keyed off the current
  // page number. page=1 → reset; page>1 → append (dedup by kind+id).
  const [pageRows, setPageRows] = useState<PageRow[]>([]);
  // Reset accumulated rows immediately when filter/source axes change so the
  // user doesn't see stale rows from the previous source while the new fetch
  // is in flight. `usePaginated` resets page→1 and kicks off the refetch; we
  // mirror that here.
  useEffect(() => {
    setPageRows([]);
  }, [source, debouncedSearch, types, installedParam]);
  useEffect(() => {
    if (loading) return;
    if (paged.page === 1) {
      setPageRows(pageItems);
      return;
    }
    setPageRows((prev) => {
      const seen = new Set<string>();
      for (const row of prev) {
        seen.add(row.kind === 'civitai' ? `civ-${row.item.id}` : `cat-${row.model.name}`);
      }
      const next = prev.slice();
      for (const row of pageItems) {
        const key = row.kind === 'civitai' ? `civ-${row.item.id}` : `cat-${row.model.name}`;
        if (!seen.has(key)) {
          seen.add(key);
          next.push(row);
        }
      }
      return next;
    });
  }, [pageItems, loading, paged.page]);

  // For the parts of the UI that only care about local catalog items (e.g.
  // the workflow-deps filter, download-by-model map) preserve the old name.
  const models = useMemo<CatalogModel[]>(
    () =>
      pageRows.flatMap((r) => (r.kind === 'catalog' ? [r.model] : [])),
    [pageRows],
  );

  // Expose refetchPage to the download-completion watcher without creating a
  // dep cycle (the watcher was declared above loadAllModels / paged).
  useEffect(() => { refetchPageRef.current = refetchPage; }, [refetchPage]);

  // Per-civitai-row transient state (busy + copied + error). Keyed by item id
  // so rows stay independent. Local rows don't need this — they use the
  // download-state map below.
  const [civitaiRowState, setCivitaiRowState] = useState<
    Record<number, { busy: boolean; copied: boolean; error: string | null }>
  >({});

  const handleInstall = useCallback(async (item: ModelRowItem) => {
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

      if (item.kind === 'civitai') {
        // Mirror CivitaiCard.handleDownload: resolve the primary file, map
        // civitai type -> comfyui dir, pre-populate catalog meta so the row
        // starts showing progress immediately.
        const CIVITAI_TYPE_TO_DIR: Record<string, string> = {
          Checkpoint: 'checkpoints',
          LORA: 'loras',
          LoCon: 'loras',
          LoRA: 'loras',
          VAE: 'vae',
          Controlnet: 'controlnet',
          ControlNet: 'controlnet',
          Upscaler: 'upscale_models',
          TextualInversion: 'embeddings',
          Hypernetwork: 'hypernetworks',
          MotionModule: 'animatediff_models',
          AestheticGradient: 'embeddings',
        };
        const civItem = item.item;
        const id = civItem.id;
        const primaryVersion = civItem.modelVersions?.[0];
        if (!primaryVersion?.id) {
          setCivitaiRowState((s) => ({
            ...s,
            [id]: { busy: false, copied: false, error: 'This item has no downloadable version' },
          }));
          return;
        }
        setCivitaiRowState((s) => ({ ...s, [id]: { busy: true, copied: false, error: null } }));
        try {
          const info = await api.getCivitaiDownloadInfo(primaryVersion.id);
          const primaryFile = info.files?.find((f) => f.primary) || info.files?.[0];
          const url =
            info.downloadUrl ||
            primaryFile?.downloadUrl ||
            primaryVersion.downloadUrl ||
            primaryVersion.files?.find((f) => f.downloadUrl)?.downloadUrl ||
            null;
          if (!url) {
            setCivitaiRowState((s) => ({
              ...s,
              [id]: { busy: false, copied: false, error: 'No download URL exposed by CivitAI for this version' },
            }));
            return;
          }
          const filename =
            primaryFile?.name ||
            primaryVersion.files?.[0]?.name ||
            `${civItem.name}.safetensors`;
          const dir = CIVITAI_TYPE_TO_DIR[civItem.type ?? ''] || 'checkpoints';
          const plainDescription = civItem.description
            ? civItem.description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || undefined
            : undefined;
          const sizeKB = primaryFile?.sizeKB ?? primaryVersion.files?.[0]?.sizeKB;
          const pageUrl = `https://civitai.com/models/${civItem.id}`;
          await api.downloadCustomModel(url, dir, {
            modelName: civItem.name,
            filename,
            meta: {
              type: civItem.type,
              description: plainDescription,
              reference: pageUrl,
              size_bytes: typeof sizeKB === 'number' ? Math.round(sizeKB * 1024) : undefined,
              thumbnail: item.thumbnail ?? undefined,
              gated: false,
              source: 'civitai',
            },
          });
          setCivitaiRowState((s) => ({ ...s, [id]: { busy: false, copied: true, error: null } }));
          setTimeout(() => {
            setCivitaiRowState((s) => {
              const cur = s[id];
              if (!cur) return s;
              return { ...s, [id]: { ...cur, copied: false } };
            });
          }, 2000);
        } catch (err) {
          setCivitaiRowState((s) => ({
            ...s,
            [id]: {
              busy: false,
              copied: false,
              error: err instanceof Error ? err.message : 'Download failed to start',
            },
          }));
        }
        return;
      }

      const model = item.model;
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
  const [infoSource, setInfoSource] = useState<ModelInfoSource | null>(null);

  const handleShowInfo = useCallback((item: ModelRowItem) => {
    setInfoSource(
      item.kind === 'civitai'
        ? { kind: 'civitai', item: item.item }
        : { kind: 'catalog', model: item.model },
    );
  }, []);

  const handleLoadMore = useCallback(() => {
    if (loading || !paged.hasMore) return;
    paged.setPage(paged.page + 1);
  }, [loading, paged]);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      await api.deleteModel({ modelName: deleteTarget.name });
      try { await api.scanModels(); } catch { /* ignore */ }
      loadAllModels();
    } catch (err) {
      console.error('Failed to delete model:', err);
    } finally {
      setDeleteTarget(null);
    }
  }, [deleteTarget, loadAllModels]);

  const handleCancelDownload = useCallback(async (_modelName: string, downloadId: string) => {
    try {
      await api.cancelDownload(downloadId);
    } catch (err) {
      console.error('Failed to cancel download:', err);
    }
  }, []);

  // Unique types from the FULL catalog (not just current page) so the sidebar
  // Types checklist is stable.
  const uniqueTypes = useMemo(() => {
    const t = new Set<string>();
    for (const m of allModels) t.add(m.type || 'other');
    return Array.from(t).sort();
  }, [allModels]);

  // When a template is selected, the required-model list is typically small
  // (<30 entries) and must not be hidden by pagination. Source from the full
  // catalog + filter client-side in that case; otherwise use the paginated
  // page. Only applies when Source = local catalog.
  const filteredModels = useMemo(() => {
    if (source !== 'local') return [];
    if (selectedWorkflow && workflowRequired.size > 0) {
      return allModels.filter(m =>
        workflowRequired.has(m.filename) || workflowRequired.has(m.name),
      );
    }
    return models;
  }, [source, models, allModels, selectedWorkflow, workflowRequired]);

  const handleDownloadAllMissing = useCallback(async () => {
    // Pull from the full catalog (not just this page) so the action truly
    // covers every missing model required by the selected workflow.
    const requiredNow = workflowRequired;
    const missing = allModels.filter(m =>
      !m.installed && (requiredNow.has(m.filename) || requiredNow.has(m.name)),
    );
    for (const model of missing) {
      await handleInstall({ kind: 'catalog', model });
    }
  }, [allModels, workflowRequired, handleInstall]);

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

  const installedCount = allModels.filter(m => m.installed).length;
  const totalDiskSize = allModels
    .filter(m => m.installed)
    .reduce((sum, m) => sum + (m.fileSize || 0), 0);
  // "Missing for workflow" counts against the full catalog so the banner count
  // reflects global state, not just the current page.
  const missingInFilter = selectedWorkflow && workflowRequired.size > 0
    ? allModels.filter(m =>
        !m.installed && (workflowRequired.has(m.filename) || workflowRequired.has(m.name)),
      ).length
    : 0;

  // Map model.name -> download descriptor so each <ModelRow> only receives the
  // download object that actually concerns it (memoized rows won't re-render
  // when unrelated download ticks arrive).
  const downloadsByModel = useMemo(() => {
    const map: Record<string, ModelRowDownload> = {};
    for (const m of models) {
      const dl = findDownloadForModel(downloads, { name: m.name, filename: m.filename });
      if (!dl) continue;
      map[m.name] = {
        modelName: m.name,
        downloadId: dl.taskId,
        progress: dl.progress,
        status: dl.status,
      };
    }
    return map;
  }, [models, downloads]);

  const handleRequestDelete = useCallback((model: CatalogModel) => {
    setDeleteTarget(model);
  }, []);

  const handleNavigateSettings = useCallback(() => {
    navigate('/settings');
  }, [navigate]);

  const subbarDescription =
    tab === 'downloads'
      ? 'Download history'
      : `${allModels.length} total, ${installedCount} installed`;

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
        <div className="panel">
          <div className="flex flex-col lg:flex-row min-h-[calc(100vh-180px)] relative">
            {/* ===== Left sidebar (Models tab only) ===== */}
            <aside className={`${tab === 'models' ? '' : 'hidden'} ${filtersOpen ? 'block' : 'hidden'} lg:block w-full lg:w-72 shrink-0 border-b lg:border-b-0 lg:border-r border-slate-200 p-4 space-y-5 bg-white ${tab !== 'models' ? 'lg:hidden' : ''}`}>
              {/* Source — local catalog vs. CivitAI remote search. */}
              <div>
                <label className="field-label mb-1.5 block">Source</label>
                <Select value={source} onValueChange={(v) => setSource(v as ModelSource)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="local">Local catalog</SelectItem>
                    <SelectItem value="civitai">CivitAI</SelectItem>
                    {/* HuggingFace is a placeholder for a future source. */}
                    <SelectItem value="huggingface" disabled>HuggingFace (coming soon)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Local-catalog-only filters. CivitAI search uses its own query
                  so these don't apply (there's no per-template dep resolution
                  against remote search results, and type/installed are local
                  concepts). */}
              {source === 'local' && (
                <>
                  {/* Template filter — the list can be 300+ entries on a
                      full catalog, so we swap to the searchable Combobox
                      beyond the shared threshold. */}
                  <div>
                    <label className="field-label mb-1.5 block">Filter by template</label>
                    {(() => {
                      const templateOptions = [
                        { label: 'All Models', value: 'all' },
                        ...templates
                          .filter(t => t.openSource === true)
                          .map(t => ({ label: t.title, value: t.name })),
                      ];
                      const current = selectedWorkflow || 'all';
                      const handle = (v: string) => setSelectedWorkflow(v === 'all' ? '' : v);
                      if (templateOptions.length > COMBOBOX_SEARCH_THRESHOLD) {
                        return (
                          <Combobox
                            value={current}
                            onValueChange={handle}
                            options={templateOptions}
                            placeholder="All Models"
                            searchPlaceholder="Search templates…"
                            emptyMessage="No matching template"
                          />
                        );
                      }
                      return (
                        <Select value={current} onValueChange={handle}>
                          <SelectTrigger>
                            <SelectValue placeholder="All Models" />
                          </SelectTrigger>
                          <SelectContent>
                            {templateOptions.map(o => (
                              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      );
                    })()}
                  </div>

                  {/* Installed filter */}
                  <div>
                    <label className="field-label mb-1.5 block">Installed</label>
                    <Select value={installedFilter} onValueChange={(v) => setInstalledFilter(v as 'all' | 'yes' | 'no')}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All</SelectItem>
                        <SelectItem value="yes">Installed</SelectItem>
                        <SelectItem value="no">Not installed</SelectItem>
                      </SelectContent>
                    </Select>
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
                </>
              )}

              {/* Storage Summary — vertical list (redesigned from the prior
                  stat-box grid). Matches the row-style language of Settings
                  StorageCard: icon + label on the left, value on the right. */}
              <div className="pt-4 border-t border-slate-200">
                <label className="field-label mb-2 block">Storage</label>
                <div className="divide-y divide-slate-100 rounded-lg ring-1 ring-inset ring-slate-200 overflow-hidden bg-white">
                  <div className="flex items-center gap-2 px-3 py-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                    <span className="text-xs text-slate-600 flex-1">Installed</span>
                    <span className="font-mono text-sm font-semibold text-slate-900">{installedCount}</span>
                  </div>
                  <div className="flex items-center gap-2 px-3 py-2">
                    <Package className="w-4 h-4 text-slate-500 shrink-0" />
                    <span className="text-xs text-slate-600 flex-1">Available</span>
                    <span className="font-mono text-sm font-semibold text-slate-900">{allModels.length}</span>
                  </div>
                  <div className="flex items-center gap-2 px-3 py-2">
                    <HardDrive className="w-4 h-4 text-teal-600 shrink-0" />
                    <span className="text-xs text-slate-600 flex-1">Disk usage</span>
                    <span className="font-mono text-sm font-semibold text-slate-900">{formatBytes(totalDiskSize)}</span>
                  </div>
                </div>
              </div>
            </aside>

            {/* ===== Right content ===== */}
            <main className="flex-1 p-4 overflow-y-auto">
              {/* Toolbar — search (Models tab only) + tab strip */}
              <div className="flex flex-col md:flex-row md:items-center gap-2 mb-4">
                {tab === 'models' && (
                  <div className="flex-1 field-wrap">
                    <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    <input
                      type="text"
                      className="field-input"
                      placeholder="Search models..."
                      value={search}
                      onChange={e => setSearch(e.target.value)}
                    />
                    {search !== '' && (
                      <button
                        type="button"
                        onClick={() => setSearch('')}
                        aria-label="Clear search"
                        className="shrink-0 text-slate-400 hover:text-slate-700 transition-colors"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                )}
                <div
                  role="tablist"
                  aria-label="Models sections"
                  className={`${tab === 'models' ? '' : 'flex-1'} inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-1 shadow-sm self-start md:self-auto`}
                >
                  <button
                    role="tab"
                    aria-selected={tab === 'models'}
                    onClick={() => setTab('models')}
                    className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-semibold transition ${
                      tab === 'models' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
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
                      tab === 'downloads' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    <History className="w-3.5 h-3.5" />
                    Downloads
                  </button>
                </div>
              </div>

              {tab === 'downloads' ? (
                <DownloadsTab />
              ) : (
              <>
              {/* Download All Missing banner — local catalog only. */}
              {source === 'local' && selectedWorkflow && missingInFilter > 0 && (
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

              {/* Models list — single flat list; type shown as badge per row.
                  Rows are a discriminated union so local + civitai items share
                  the same visual footprint. */}
              {loading && pageRows.length === 0 ? (
                // Skeleton grid during the initial fetch or while switching
                // source. 6 rows × animate-pulse mirror the real ModelRow
                // silhouette (32px thumb + two text lines).
                <section className="panel">
                  <div className="divide-y divide-slate-100">
                    {[0, 1, 2, 3, 4, 5].map((i) => (
                      <div key={`sk-${i}`} className="flex items-center gap-3 py-2.5 px-4">
                        <div className="w-8 h-8 rounded bg-slate-100 animate-pulse shrink-0" />
                        <div className="flex-1 min-w-0 space-y-1.5">
                          <div className="h-3 w-1/2 rounded bg-slate-100 animate-pulse" />
                          <div className="h-2.5 w-1/3 rounded bg-slate-100 animate-pulse" />
                        </div>
                        <div className="h-7 w-20 rounded bg-slate-100 animate-pulse shrink-0" />
                      </div>
                    ))}
                  </div>
                </section>
              ) : source === 'local' && filteredModels.length > 0 ? (
                <section className="panel">
                  <div className="divide-y divide-slate-100">
                    {filteredModels.map((model, i) => {
                      const isRequired = workflowRequired.has(model.filename) || workflowRequired.has(model.name);
                      return (
                        <ModelRow
                          key={`${model.name}-${i}`}
                          item={{ kind: 'catalog', model }}
                          download={downloadsByModel[model.name]}
                          isRequired={isRequired}
                          selectedWorkflow={selectedWorkflow}
                          hfTokenConfigured={hfTokenConfigured}
                          showTypeBadge
                          onInstall={handleInstall}
                          onDelete={handleRequestDelete}
                          onCancelDownload={handleCancelDownload}
                          onNavigateSettings={handleNavigateSettings}
                          onShowInfo={handleShowInfo}
                        />
                      );
                    })}
                  </div>
                </section>
              ) : source === 'civitai' && pageRows.length > 0 ? (
                <section className="panel">
                  <div className="divide-y divide-slate-100">
                    {pageRows.map((row, i) => {
                      if (row.kind !== 'civitai') return null;
                      const civ = row.item;
                      const state = civitaiRowState[civ.id];
                      // Prefer the first image from the primary version for
                      // the row thumbnail — matches the card view's logic.
                      // Route through the backend proxy + md5 cache so rows
                      // don't pull multi-MB previews off the civitai CDN.
                      let thumb: string | null = null;
                      outer: for (const v of civ.modelVersions || []) {
                        for (const img of v.images || []) {
                          if (img.url && (img.type || 'image') === 'image') {
                            thumb = imgProxy(img.url, 96) ?? null;
                            break outer;
                          }
                        }
                      }
                      const sizeKB = civ.modelVersions?.[0]?.files?.[0]?.sizeKB;
                      return (
                        <ModelRow
                          key={`civ-${civ.id}-${i}`}
                          item={{
                            kind: 'civitai',
                            item: civ,
                            thumbnail: thumb,
                            sizeBytes: typeof sizeKB === 'number' ? Math.round(sizeKB * 1024) : null,
                            busy: !!state?.busy,
                            copied: !!state?.copied,
                            error: state?.error ?? null,
                          }}
                          hfTokenConfigured={hfTokenConfigured}
                          showTypeBadge
                          onInstall={handleInstall}
                          onCancelDownload={handleCancelDownload}
                          onNavigateSettings={handleNavigateSettings}
                          onShowInfo={handleShowInfo}
                        />
                      );
                    })}
                  </div>
                </section>
              ) : (
                <div className="text-center py-16">
                  {source === 'civitai' ? (
                    <>
                      <Box className="w-10 h-10 text-slate-200 mx-auto mb-3" />
                      <p className="text-sm font-medium text-slate-500">
                        {search.trim() ? `No results for "${search}"` : 'No CivitAI models found.'}
                      </p>
                      <p className="text-xs text-slate-400 mt-1">Try a different search query.</p>
                    </>
                  ) : !connected ? (
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
                  ) : allModels.length === 0 ? (
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

              {/* Load more — replaces the page-based Pagination widget.
                  CivitAI search is cursor-based and the local catalog feels
                  better as an accumulator too. Hidden when browsing the local
                  catalog with a template filter active (required-model list
                  is a fixed set — load-more would be misleading). */}
              {!(source === 'local' && selectedWorkflow) && pageRows.length > 0 && (
                <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 flex items-center justify-center">
                  {paged.hasMore ? (
                    <button
                      type="button"
                      onClick={handleLoadMore}
                      disabled={loading}
                      className="btn-secondary"
                    >
                      {loading ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : null}
                      {loading ? 'Loading…' : 'Load more'}
                    </button>
                  ) : (
                    <span className="text-xs text-slate-500">No more results</span>
                  )}
                </div>
              )}
              </>
              )}
            </main>
          </div>
        </div>
      </div>

      <ModelInfoModal
        open={!!infoSource}
        onClose={() => setInfoSource(null)}
        source={infoSource}
      />

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
