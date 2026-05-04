import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Box, Trash2, Search, WifiOff, Settings,
  Download, SlidersHorizontal, History, X, HardDrive, CheckCircle2, Package,
  RefreshCw,
} from 'lucide-react';
import { Spinner } from '../components/ui/spinner';
import { toast } from 'sonner';
import type { CatalogModel, CivitaiModelSummary, RequiredItem, RequiredModel } from '../types';
import { findDownloadForModel } from '../types';
import { api, type PageEnvelope } from '../services/comfyui';
import { useApp } from '../context/AppContext';
import { usePersistedState } from '../hooks/usePersistedState';
import { usePaginated } from '../hooks/usePaginated';
import PageSubbar from '../components/layout/PageSubbar';
import Pagination from '../components/layout/Pagination';
import DownloadsTab from '../components/DownloadsTab';
import OllamaModelsPanel from '../components/OllamaModelsPanel';
import ModelRow, { type ModelRowDownload, type ModelRowItem } from '../components/cards/ModelRow';
import ModelInfoModal, { type ModelInfoSource } from '../components/modals/ModelInfoModal';
import ModelFolderPickerModal from '../components/modals/ModelFolderPickerModal';
import { formatBytes } from '../lib/utils';
import { imgProxy } from '../lib/imgProxy';
import { SelectField, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/forms/SelectField';
import { Combobox, COMBOBOX_SEARCH_THRESHOLD } from '../components/ui/combobox';
import { Checkbox } from '../components/ui/checkbox';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import ConfirmDialog from '../components/modals/ConfirmDialog';

type ModelsTab = 'models' | 'downloads';

// Catalog `type` -> ComfyUI models/<dir> mapping. Lives at module scope so
// the install handler + folder-picker pre-selection both read the same table.
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
  // Source: local catalog | CivitAI | Ollama. Can be primed from
  // `?source=ollama` (the legacy /chat/models redirect lands here) or
  // `?source=civitai` (the legacy /plugins/civitai/models redirect).
  type ModelSource = 'local' | 'civitai' | 'ollama';
  const urlSource = searchParams.get('source');
  const initialSource: ModelSource =
    urlSource === 'civitai' ? 'civitai'
    : urlSource === 'ollama' ? 'ollama'
    : 'local';
  const [source, setSource] = usePersistedState<ModelSource>(
    'models.source',
    initialSource,
  );
  useEffect(() => {
    if (urlSource === 'civitai' && source !== 'civitai') setSource('civitai');
    else if (urlSource === 'ollama' && source !== 'ollama') setSource('ollama');
    // URL → state sync is one-way; we don't want the source to ping-pong.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlSource]);

  // CivitAI feed picker — Latest / Hot / Search. Mirrors Explore's UX so
  // both pages have the same vocabulary. Persisted so a reload restores it.
  // CivitAI's "Most Downloaded" sort returns cursor-based responses (page=
  // is silently ignored upstream) so we thread `nextCursor` between fetches
  // — see `civCursorRef` below.
  type CivitaiFeed = 'latest' | 'hot' | 'search';
  const [civitaiFeed, setCivitaiFeed] = usePersistedState<CivitaiFeed>(
    'models.civitaiFeed',
    'hot',
  );
  const civCursorRef = useRef<string | undefined>(undefined);
  // Reset the cursor whenever a civitai axis changes (source, feed, or
  // search query). usePaginated's own deps array resets `page→1`; we just
  // need to clear the cursor in lock-step so page-1 fetches fresh, not
  // from the previous feed's tail.
  useEffect(() => {
    civCursorRef.current = undefined;
  }, [source, civitaiFeed, debouncedSearch]);

  // Sidebar aggregates (installedCount + totalDiskSize + types) come from
  // /models/stats — a server-side aggregation that replaces the prior
  // full-catalog fetch. The displayed list is server-paginated; only the
  // sidebar counts + Types checklist need a global view, and now those
  // come pre-aggregated.
  const [stats, setStats] = useState<{
    installedCount: number;
    available: number;
    totalDiskSize: number;
    types: string[];
  } | null>(null);
  const lastCompletedRef = useRef<Set<string>>(new Set());

  const loadStats = useCallback(async () => {
    try { setStats(await api.getModelsStats()); } catch { setStats(null); }
  }, []);

  // Workflow-dependency state — kept as the FULL list of RequiredItem so the
  // "Download All Missing" button has the metadata it needs to install each
  // missing model directly (no full-catalog scan). `workflowRequired` is the
  // Set<string> of required model names, derived from the same list, used
  // for the highlight-required-row UI cue.
  const [workflowDeps, setWorkflowDeps] = useState<RequiredItem[]>([]);

  useEffect(() => {
    loadStats();
    refreshTemplates();
  }, [loadStats, refreshTemplates]);

  // Watch for completed downloads → rescan + refresh stats + current page.
  // `refetchPage` is pulled from the `paged` memo below; set after it's defined.
  const refetchPageRef = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => {
    for (const [taskId, dl] of Object.entries(downloads)) {
      if ((dl.completed || dl.status === 'completed') && !lastCompletedRef.current.has(taskId)) {
        lastCompletedRef.current.add(taskId);
        (async () => {
          try { await api.scanModels(); } catch { /* ignore */ }
          await loadStats();
          // Explicitly refetch the visible page once so newly-installed
          // rows reflect their `installed` flag.
          await refetchPageRef.current?.();
        })();
      }
    }
  }, [downloads, loadStats]);

  // When workflow filter changes, check dependencies
  useEffect(() => {
    if (!selectedWorkflow) {
      setWorkflowRequired(new Set());
      setWorkflowDeps([]);
      return;
    }
    api.checkDependencies(selectedWorkflow)
      .then(result => {
        // Models page only cares about model rows, not plugin entries.
        const names = new Set<string>();
        const modelDeps: RequiredItem[] = [];
        for (const r of result.required) {
          if (r.kind !== 'plugin') {
            names.add(r.name);
            modelDeps.push(r);
          }
        }
        setWorkflowRequired(names);
        setWorkflowDeps(modelDeps);
      })
      .catch(() => { setWorkflowRequired(new Set()); setWorkflowDeps([]); });
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
        // Cursor threading: Civitai's Most-Downloaded sort silently ignores
        // `page=`. We pass the previous response's `nextCursor` on every
        // fetch after page 1; the cursor was reset to undefined when the
        // axis changed (see `civCursorRef` effect above).
        const cursor = page > 1 ? civCursorRef.current : undefined;
        const trimmed = debouncedSearch.trim();
        let res: PageEnvelope<CivitaiModelSummary>;
        if (civitaiFeed === 'search') {
          if (!trimmed) {
            // Empty search query → reset and short-circuit. Don't hit the
            // server; the empty-state branch renders the "type a query" hint.
            civCursorRef.current = undefined;
            return { items: [], total: 0, hasMore: false };
          }
          res = await api.searchCivitaiModels(trimmed, { pageSize, cursor });
        } else if (civitaiFeed === 'hot') {
          res = await api.getCivitaiHotModels({ page, pageSize, cursor });
        } else {
          res = await api.getCivitaiLatestModels({ page, pageSize, cursor });
        }
        civCursorRef.current = res.nextCursor;
        return {
          items: res.items.map<PageRow>((item) => ({ kind: 'civitai', item })),
          total: res.total,
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
    [source, civitaiFeed, debouncedSearch, types, installedParam],
  );
  const paged = usePaginated<PageRow>(fetcher, {
    deps: [source, civitaiFeed, debouncedSearch, types, installedParam],
  });
  const { items: pageItems, loading, refetch: refetchPage } = paged;

  // Pagination strategy split:
  //  - CivitAI uses "Load more" + an IntersectionObserver sentinel. Pages
  //    accumulate (`pageRows`) and dedup by `civ-<id>`. CivitAI's API doesn't
  //    return a stable `total`, so numbered pagination wouldn't work.
  //  - Local catalog uses numbered <Pagination>. Each page replaces the
  //    previous (no accumulator); `total` from the server drives the page
  //    count. Faster jumps + jump-to-last vs the old infinite-scroll feel.
  const [pageRows, setPageRows] = useState<PageRow[]>([]);
  useEffect(() => {
    // On any axis change reset the accumulator AND mirror the new pageItems
    // immediately so local-catalog renders show no stale rows.
    setPageRows([]);
  }, [source, civitaiFeed, debouncedSearch, types, installedParam]);
  useEffect(() => {
    if (loading) return;
    // Local + Ollama (Ollama renders elsewhere — guard preserved): always
    // replace with the current page only.
    if (source !== 'civitai') {
      setPageRows(pageItems);
      return;
    }
    // CivitAI: accumulate.
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
  }, [pageItems, loading, paged.page, source]);

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

  // Pending model awaiting a manual folder choice (Fix 3). Set when the user
  // clicks Install on a row whose save_path is unresolvable AND whose type
  // doesn't map to a known dir; cleared when the user picks one + downloads
  // or cancels.
  const [folderPickModel, setFolderPickModel] = useState<CatalogModel | null>(null);

  const installCatalogWithDir = useCallback(async (model: CatalogModel, dir: string) => {
    if (model.url) {
      await api.downloadCustomModel(model.url, dir, { modelName: model.name, filename: model.filename });
    } else {
      await api.installModel(model.name);
    }
  }, []);

  const handleInstall = useCallback(async (item: ModelRowItem) => {
    try {
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
      const explicitSavePath = model.save_path && model.save_path !== 'default' ? model.save_path : '';
      const typeDerived = TYPE_TO_DIR[model.type];
      // Block the install when no save_path AND no type-derived fallback —
      // silently writing such files to checkpoints/ has caused user confusion
      // for ONNX detectors, GGUF quants, etc. Only catalog rows with a URL
      // can resume from the picker; URL-less rows hit installFromCatalog
      // server-side which throws NoDownloadSourceError.
      if (!explicitSavePath && !typeDerived && model.url) {
        setFolderPickModel(model);
        return;
      }
      const dir = explicitSavePath || typeDerived || model.type || 'checkpoints';
      await installCatalogWithDir(model, dir);
      // Backend tracks + broadcasts; state will arrive via the `download` WS message.
    } catch (err) {
      console.error('Failed to start download:', err);
      toast.error('Download failed', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }, [installCatalogWithDir]);

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

  // Infinite scroll: a sentinel div is rendered where the old "Load more"
  // button lived; when it intersects the viewport, advance the page. Refs
  // mirror live state so the observer callback (created once per sentinel
  // element) reads the latest values without re-binding.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const handleLoadMoreRef = useRef(handleLoadMore);
  handleLoadMoreRef.current = handleLoadMore;
  const hasMoreRef = useRef(paged.hasMore);
  hasMoreRef.current = paged.hasMore;
  const loadingRef = useRef(loading);
  loadingRef.current = loading;
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting && hasMoreRef.current && !loadingRef.current) {
          handleLoadMoreRef.current();
        }
      }
    }, { rootMargin: '200px' });
    obs.observe(el);
    return () => obs.disconnect();
  }, [pageRows.length]);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      await api.deleteModel({ modelName: deleteTarget.name });
      try { await api.scanModels(); } catch { /* ignore */ }
      // Mirror the post-install path: refresh the full catalog AND the
      // visible page so the deleted row drops out immediately instead of
      // sticking around with a stale "Installed" badge.
      await loadStats();
      await refetchPageRef.current?.();
    } catch (err) {
      console.error('Failed to delete model:', err);
    } finally {
      setDeleteTarget(null);
    }
  }, [deleteTarget, loadStats]);

  const [rescanning, setRescanning] = useState(false);
  const handleRescan = useCallback(async () => {
    if (rescanning) return;
    setRescanning(true);
    try {
      const res = await api.rescanModelIndex();
      toast.success('Index updated', {
        description: `Indexed ${res.total} files (added ${res.added}, removed ${res.removed}).`,
      });
      await loadStats();
      await refetchPageRef.current?.();
    } catch (err) {
      console.error('Rescan failed:', err);
      toast.error('Rescan failed', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRescanning(false);
    }
  }, [rescanning, loadStats]);

  const handleCancelDownload = useCallback(async (_modelName: string, downloadId: string) => {
    try {
      await api.cancelDownload(downloadId);
    } catch (err) {
      console.error('Failed to cancel download:', err);
    }
  }, []);

  // Unique types from the FULL catalog (not just current page) so the sidebar
  // Types checklist — pulled from /models/stats so we don't need the full
  // catalog client-side.
  const uniqueTypes = useMemo(() => stats?.types ?? [], [stats]);

  // When a template is selected, the visible grid currently shows whatever
  // the paginated fetch returns — `workflowRequired` highlights required
  // rows (`isRequired` badge in <ModelRow>). The dependency modal continues
  // to be the place where the user sees the FULL required list in one
  // place; the grid's job is to filter the local catalog.
  const filteredModels = useMemo(() => {
    if (source !== 'local') return [];
    return models;
  }, [source, models]);

  const handleDownloadAllMissing = useCallback(async () => {
    // Use the dependency-check result directly — each `RequiredModel` already
    // has the URL + directory + (optional) hfRepo we need to start a download.
    // No full-catalog scan required.
    const missing = workflowDeps.filter(
      (d): d is RequiredModel => d.kind !== 'plugin' && !d.installed,
    );
    for (const m of missing) {
      try {
        if (m.hfRepo) {
          await api.downloadHfRepo(m.hfRepo, m.directory, m.name);
        } else {
          await api.downloadCustomModel(m.url, m.directory || 'checkpoints', {
            modelName: m.name,
            filename: m.name,
          });
        }
      } catch (err) {
        toast.error(`Failed to start ${m.name}`, {
          description: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }, [workflowDeps]);

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

  const installedCount = stats?.installedCount ?? 0;
  const totalDiskSize = stats?.totalDiskSize ?? 0;
  // "Missing for workflow" comes from the dependency-check result so the
  // banner count reflects global state — not just the current paginated page.
  const missingInFilter = workflowDeps.filter(
    (d): d is RequiredModel => d.kind !== 'plugin' && !d.installed,
  ).length;

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
      : `${stats?.available ?? 0} total, ${installedCount} installed`;

  return (
    <>
      <PageSubbar
        title="Models"
        description={subbarDescription}
        right={
          tab === 'models' ? (
            <Button
              onClick={() => setFiltersOpen(o => !o)}
              variant="secondary"
              className="lg:hidden"
              aria-label="Toggle filters"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              Filters
            </Button>
          ) : null
        }
      />
      <div className="page-container">
        <Card>
          <div className="flex flex-col lg:flex-row min-h-[calc(100vh-180px)] relative">
            {/* ===== Left sidebar (Models tab only) ===== */}
            <aside className={`${tab === 'models' ? '' : 'hidden'} ${filtersOpen ? 'block' : 'hidden'} lg:block w-full lg:w-72 shrink-0 border-b lg:border-b-0 lg:border-r border-slate-200 p-4 space-y-5 bg-white ${tab !== 'models' ? 'lg:hidden' : ''}`}>
              {/* Source — local catalog vs. CivitAI remote search. */}
              <div>
                <label className="field-label mb-1.5 block">Source</label>
                <SelectField value={source} onValueChange={(v) => setSource(v as ModelSource)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="local">Local catalog</SelectItem>
                    <SelectItem value="civitai">CivitAI</SelectItem>
                    <SelectItem value="ollama">Ollama (chat models)</SelectItem>
                    {/* HuggingFace is a placeholder for a future source. */}
                    <SelectItem value="huggingface" disabled>HuggingFace (coming soon)</SelectItem>
                  </SelectContent>
                </SelectField>
              </div>

              {/* CivitAI feed picker — Latest / Hot / Search. Only visible
                  when source === 'civitai'. Mirrors the Explore sidebar so
                  the vocabulary is consistent across pages. */}
              {source === 'civitai' && (
                <div>
                  <label className="field-label mb-1.5 block">Feed</label>
                  <SelectField value={civitaiFeed} onValueChange={(v) => setCivitaiFeed(v as CivitaiFeed)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="latest">Latest</SelectItem>
                      <SelectItem value="hot">Hot</SelectItem>
                      <SelectItem value="search">Search</SelectItem>
                    </SelectContent>
                  </SelectField>
                  {civitaiFeed === 'search' && !debouncedSearch.trim() && (
                    <p className="mt-1.5 text-[11px] text-slate-500">
                      Type a query in the Search box above to run a CivitAI search.
                    </p>
                  )}
                </div>
              )}

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
                        <SelectField value={current} onValueChange={handle}>
                          <SelectTrigger>
                            <SelectValue placeholder="All Models" />
                          </SelectTrigger>
                          <SelectContent>
                            {templateOptions.map(o => (
                              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </SelectField>
                      );
                    })()}
                  </div>

                  {/* Installed filter */}
                  <div>
                    <label className="field-label mb-1.5 block">Installed</label>
                    <SelectField value={installedFilter} onValueChange={(v) => setInstalledFilter(v as 'all' | 'yes' | 'no')}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All</SelectItem>
                        <SelectItem value="yes">Installed</SelectItem>
                        <SelectItem value="no">Not installed</SelectItem>
                      </SelectContent>
                    </SelectField>
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

              {/* Storage Summary — local catalog stats. Hidden for Ollama,
                  whose installed/disk-usage numbers come from `ollama list`
                  and would conflict with the local catalog totals shown
                  here. */}
              {source !== 'ollama' && (
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
                      <span className="font-mono text-sm font-semibold text-slate-900">{stats?.available ?? 0}</span>
                    </div>
                    <div className="flex items-center gap-2 px-3 py-2">
                      <HardDrive className="w-4 h-4 text-teal-600 shrink-0" />
                      <span className="text-xs text-slate-600 flex-1">Disk usage</span>
                      <span className="font-mono text-sm font-semibold text-slate-900">{formatBytes(totalDiskSize)}</span>
                    </div>
                  </div>
                </div>
              )}
            </aside>

            {/* ===== Right content ===== */}
            <main className="flex-1 p-4 overflow-y-auto">
              {/* Ollama source pane — its own tab strip (Installed / Library /
                  HuggingFace) replaces the Models/Downloads strip used for
                  the local + civitai sources. Mounted via OllamaModelsPanel
                  which owns its own search, refresh, and pull state. */}
              {source === 'ollama' ? (
                <OllamaModelsPanel />
              ) : (
              <>
              {/* Toolbar — search (Models tab only) + tab strip */}
              <div className="flex flex-col md:flex-row md:items-center gap-2 mb-4">
                {tab === 'models' && (
                  <>
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
                  </>
                )}
                <div
                  role="tablist"
                  aria-label="Models sections"
                  className={`tab-strip self-start md:self-auto ${tab === 'models' ? '' : 'flex-1'}`}
                >
                  <button
                    role="tab"
                    aria-selected={tab === 'models'}
                    onClick={() => setTab('models')}
                    className={`tab-strip-item ${tab === 'models' ? 'is-active' : ''}`}
                  >
                    <Box className="w-3.5 h-3.5" />
                    Models
                  </button>
                  <button
                    role="tab"
                    aria-selected={tab === 'downloads'}
                    onClick={() => setTab('downloads')}
                    className={`tab-strip-item ${tab === 'downloads' ? 'is-active' : ''}`}
                  >
                    <History className="w-3.5 h-3.5" />
                    Downloads
                  </button>
                  {/* Rescan sits inline with the tabs (action, not a tab —
                      no aria-selected). Tinted teal so it's visually marked
                      as an action and doesn't read as an "off" tab waiting
                      to be picked. */}
                  <button
                    type="button"
                    onClick={handleRescan}
                    disabled={rescanning}
                    aria-label="Rescan models on disk"
                    title="Rescan model files on disk"
                    className="tab-strip-item text-teal-700 hover:text-teal-800 hover:bg-teal-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${rescanning ? 'animate-spin' : ''}`} />
                    {rescanning ? 'Rescanning…' : 'Rescan'}
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
                  <Button onClick={handleDownloadAllMissing}>
                    <Download className="w-3.5 h-3.5" />
                    Download All Missing ({missingInFilter})
                  </Button>
                </div>
              )}

              {/* Models list — single flat list; type shown as badge per row.
                  Rows are a discriminated union so local + civitai items share
                  the same visual footprint. */}
              {loading && pageRows.length === 0 ? (
                // Skeleton grid during the initial fetch or while switching
                // source. 6 rows × animate-pulse mirror the real ModelRow
                // silhouette (32px thumb + two text lines).
                <Card>
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
                </Card>
              ) : source === 'local' && filteredModels.length > 0 ? (
                <Card>
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
                </Card>
              ) : source === 'civitai' && pageRows.length > 0 ? (
                <Card>
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
                </Card>
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
                      <Button
                        onClick={() => navigate('/settings')}
                        variant="secondary"
                      >
                        <Settings className="w-3.5 h-3.5" />
                        Check Settings
                      </Button>
                    </>
                  ) : (stats?.available ?? 0) === 0 ? (
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

              {/* CivitAI: infinite-scroll sentinel. CivitAI's API doesn't
                  ship a usable `total`, so numbered pagination isn't an
                  option here — keep "Load more" via the
                  IntersectionObserver above. */}
              {source === 'civitai' && pageRows.length > 0 && (
                <div
                  ref={sentinelRef}
                  className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 flex items-center justify-center"
                >
                  {paged.hasMore ? (
                    <span className="inline-flex items-center gap-2 text-xs text-slate-500">
                      {loading && <Spinner size="sm" />}
                      {loading ? 'Loading more…' : 'Scroll to load more'}
                    </span>
                  ) : (
                    <span className="text-xs text-slate-500">No more results</span>
                  )}
                </div>
              )}

              {/* Local catalog: numbered Pagination — page-replace, jump-by-page,
                  page-size select. Hidden when a workflow filter is active
                  (the required-model list is a fixed set, paging would just
                  hide rows the user picked the workflow to surface). */}
              {source === 'local' && !selectedWorkflow && paged.total > 0 && (
                <div className="mt-4">
                  <Pagination
                    page={paged.page}
                    pageSize={paged.pageSize}
                    total={paged.total}
                    hasMore={paged.hasMore}
                    onPageChange={paged.setPage}
                    onPageSizeChange={paged.setPageSize}
                  />
                </div>
              )}
              </>
              )}
              </>
              )}
            </main>
          </div>
        </Card>
      </div>

      <ModelInfoModal
        open={!!infoSource}
        onClose={() => setInfoSource(null)}
        source={infoSource}
      />

      <ModelFolderPickerModal
        open={!!folderPickModel}
        modelName={folderPickModel?.filename || folderPickModel?.name || ''}
        preferred={folderPickModel ? TYPE_TO_DIR[folderPickModel.type] : undefined}
        onCancel={() => setFolderPickModel(null)}
        onConfirm={async (folder) => {
          const target = folderPickModel;
          setFolderPickModel(null);
          if (!target) return;
          try {
            await installCatalogWithDir(target, folder);
          } catch (err) {
            console.error('Failed to start download:', err);
            toast.error('Download failed', {
              description: err instanceof Error ? err.message : String(err),
            });
          }
        }}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="Delete model?"
        description={`This will permanently delete "${deleteTarget?.filename || deleteTarget?.name}" from disk. You can re-download it later.`}
        confirmLabel="Delete"
        confirmTone="danger"
        onConfirm={confirmDelete}
      />
    </>
  );
}
