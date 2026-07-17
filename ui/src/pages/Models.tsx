import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Box, Trash2, Search, WifiOff, Settings,
  Download, SlidersHorizontal, History, X, HardDrive, CheckCircle2, Package,
  RefreshCw, Sparkles,
} from 'lucide-react';
import { Spinner } from '../components/ui/spinner';
import { toast } from 'sonner';
import type { CatalogModel, CivitaiModelSummary, RequiredItem, RequiredModel } from '../types';
import { findDownloadForModel } from '../types';
import { api, type PageEnvelope, type CivitaiFacetsResponse } from '../services/comfyui';
import { useApp } from '../context/AppContext';
import { usePersistedState } from '../hooks/usePersistedState';
import { usePaginated } from '../hooks/usePaginated';
import PageSubbar from '../components/layout/PageSubbar';
import PageAside from '../components/layout/PageAside';
import Pagination from '../components/layout/Pagination';
import DownloadsTab from '../components/DownloadsTab';
import OllamaModelsPanel from '../components/OllamaModelsPanel';
import ModelRow, { type ModelRowDownload, type ModelRowItem } from '../components/cards/ModelRow';
import ModelInfoModal, { type ModelInfoSource } from '../components/modals/ModelInfoModal';
import CivitaiFilterSidebar from '../components/CivitaiFilterSidebar';
import ModelFolderPickerModal from '../components/modals/ModelFolderPickerModal';
import { formatBytes } from '../lib/utils';
import { imgProxy } from '../lib/imgProxy';
import { SelectField, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/forms/SelectField';
import { Combobox, COMBOBOX_SEARCH_THRESHOLD } from '../components/ui/combobox';
import { Checkbox } from '../components/ui/checkbox';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import ConfirmDialog from '../components/modals/ConfirmDialog';
import RecipesPanel from '../components/cards/RecipesPanel';

type ModelsTab = 'models' | 'downloads' | 'recipes';

// Fallback map used until the server responds. Kept in sync manually;
// the authoritative version is fetched from /models/type-map on mount.
const FALLBACK_TYPE_TO_DIR: Record<string, string> = {
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
  embeddings: 'embeddings',
  'IP-Adapter': 'ipadapter',
  clip: 'clip',
  clip_vision: 'clip_vision',
  text_encoder: 'text_encoders',
  text_encoders: 'text_encoders',
  diffusion_model: 'diffusion_models',
  diffusion_models: 'diffusion_models',
  unet: 'unet',
};

const FALLBACK_CIVITAI_TYPE_TO_DIR: Record<string, string> = {
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
  const initialTab: ModelsTab = urlTab === 'downloads' ? 'downloads' : urlTab === 'recipes' ? 'recipes' : 'models';
  const [tab, setTab] = useState<ModelsTab>(initialTab);

  // Server-authoritative type→dir maps. Start from static fallback so the UI
  // renders correctly before the fetch resolves.
  const [typeToDirMap, setTypeToDirMap] = useState<Record<string, string>>(FALLBACK_TYPE_TO_DIR);
  const [civitaiTypeToDirMap, setCivitaiTypeToDirMap] = useState<Record<string, string>>(FALLBACK_CIVITAI_TYPE_TO_DIR);
  useEffect(() => {
    api.getTypeMap().then((m) => {
      if (m && Object.keys(m.types).length > 0) setTypeToDirMap(m.types);
      if (m && Object.keys(m.civitaiTypes).length > 0) setCivitaiTypeToDirMap(m.civitaiTypes);
    }).catch(() => { /* fallback already set */ });
  }, []);

  // Keep URL in sync when the tab changes (and react to back/forward).
  useEffect(() => {
    const current = searchParams.get('tab');
    const desired = tab === 'downloads' ? 'downloads' : tab === 'recipes' ? 'recipes' : null;
    if (desired === current) return;
    const next = new URLSearchParams(searchParams);
    if (desired) next.set('tab', desired);
    else next.delete('tab');
    setSearchParams(next, { replace: true });
  }, [tab, searchParams, setSearchParams]);

  useEffect(() => {
    const fromUrl: ModelsTab = urlTab === 'downloads' ? 'downloads' : urlTab === 'recipes' ? 'recipes' : 'models';
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
  const [enrichAllBusy, setEnrichAllBusy] = useState(false);

  // Kick off the background hash+enrich queue for every installed model whose
  // sidecar is empty or hasn't been touched. Server returns { enqueued, message };
  // toast confirms the count. Catalog rows update as `model:enriched` events fire.
  const handleEnrichAll = useCallback(async () => {
    if (enrichAllBusy) return;
    setEnrichAllBusy(true);
    try {
      const res = await api.enrichAllModels();
      const enqueued = res?.enqueued ?? 0;
      toast.success(
        enqueued > 0
          ? `Enrichment queued for ${enqueued} model${enqueued === 1 ? '' : 's'}`
          : 'All installed models are already enriched',
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to start enrichment');
    } finally {
      setEnrichAllBusy(false);
    }
  }, [enrichAllBusy]);
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
    // /models (no source) is the Comfy template's home. If we landed here
    // from /models?source=ollama, drop back to the comfy default — without
    // this the persisted ollama state survives the navigation and the
    // Comfy submenu would show the Ollama panel.
    else if (!urlSource && source === 'ollama') setSource('local');
    // URL → state sync is one-way; we don't want the source to ping-pong.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlSource]);

  // CivitAI search filters. Vocabulary (types/baseModels/periods/sorts)
  // is fetched dynamically from `/civitai/models/facets` so chip lists are
  // never hardcoded here. `nsfw` defaults off; selections persist across
  // reloads via usePersistedState (keys: `models.civitai.*`).
  const [civitaiTypes, setCivitaiTypes] = usePersistedState<string[]>('models.civitai.types', []);
  const [civitaiBaseModels, setCivitaiBaseModels] = usePersistedState<string[]>('models.civitai.baseModels', []);
  const [civitaiNsfw, setCivitaiNsfw] = usePersistedState<boolean>('models.civitai.nsfw', false);
  const [civitaiPeriod, setCivitaiPeriod] = usePersistedState<string>('models.civitai.period', 'AllTime');
  const [civitaiSort, setCivitaiSort] = usePersistedState<string>('models.civitai.sort', 'Highest Rated');
  const [facets, setFacets] = useState<CivitaiFacetsResponse | null>(null);
  const [facetsLoading, setFacetsLoading] = useState(false);
  useEffect(() => {
    if (source !== 'civitai' || facets) return;
    setFacetsLoading(true);
    api.getCivitaiFacets()
      .then((f) => setFacets(f))
      .catch(() => { /* sidebar gracefully renders with empty arrays */ })
      .finally(() => setFacetsLoading(false));
  }, [source, facets]);
  const civCursorRef = useRef<string | undefined>(undefined);
  // Reset cursor whenever a civitai axis changes. usePaginated's own deps
  // array resets `page→1`; we just need to clear the cursor in lock-step
  // so page-1 fetches fresh, not from the previous filter set's tail.
  // (Joined strings keep the dep array primitive — Set/Array identity changes
  // would otherwise refire on every render.)
  const civitaiTypesKey = useMemo(() => civitaiTypes.slice().sort().join('|'), [civitaiTypes]);
  const civitaiBaseModelsKey = useMemo(
    () => civitaiBaseModels.slice().sort().join('|'),
    [civitaiBaseModels],
  );
  useEffect(() => {
    civCursorRef.current = undefined;
  }, [source, debouncedSearch, civitaiTypesKey, civitaiBaseModelsKey, civitaiNsfw, civitaiPeriod, civitaiSort]);

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
  // When a template is picked, narrow the catalog query to just that
  // template's required basenames. Stable identity via sort so the fetcher
  // dep array doesn't refire on insertion-order shuffle.
  const filenamesParam = useMemo(() => {
    if (!selectedWorkflow || workflowRequired.size === 0) return undefined;
    return Array.from(workflowRequired).sort();
  }, [selectedWorkflow, workflowRequired]);

  // A shared row type covers both local catalog items + civitai search results
  // so `usePaginated` / the grid stay single-fetcher. Local rows carry a
  // CatalogModel; remote rows carry a CivitaiModelSummary.
  type PageRow =
    | { kind: 'catalog'; model: CatalogModel }
    | { kind: 'civitai'; item: CivitaiModelSummary };

  const fetcher = useCallback(
    async ({ page, pageSize }: { page: number; pageSize: number }) => {
      // Ollama owns its own panel + fetches — skip the catalog round-trip
      // when the page is in Ollama mode (otherwise we'd burn a request on
      // local-catalog rows the user never sees).
      if (source === 'ollama') {
        return { items: [], total: 0, hasMore: false };
      }
      if (source === 'civitai') {
        // Cursor threading: CivitAI's search sort silently ignores `page=`
        // when `query=` is set, and even filter-only browses use cursor
        // pagination. Pass the previous response's `nextCursor` after page 1.
        const cursor = page > 1 ? civCursorRef.current : undefined;
        const trimmed = debouncedSearch.trim();
        const hasFilter =
          civitaiTypes.length > 0
          || civitaiBaseModels.length > 0
          || civitaiNsfw === true;
        // Empty query AND no filters AND NSFW off → short-circuit. Don't
        // hit the server; the empty-state branch renders the "type a
        // query or pick a filter" hint.
        if (!trimmed && !hasFilter) {
          civCursorRef.current = undefined;
          return { items: [], total: 0, hasMore: false };
        }
        const res: PageEnvelope<CivitaiModelSummary> = await api.searchCivitaiModels(trimmed, {
          page, pageSize, cursor,
          types: civitaiTypes.length > 0 ? civitaiTypes : undefined,
          baseModels: civitaiBaseModels.length > 0 ? civitaiBaseModels : undefined,
          nsfw: civitaiNsfw,
          period: civitaiPeriod,
          sort: civitaiSort,
        });
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
        filenames: filenamesParam,
      });
      return {
        items: res.items.map<PageRow>((model) => ({ kind: 'catalog', model })),
        total: res.meta.total ?? 0,
        hasMore: res.meta.hasMore ?? false,
      };
    },
    [
      source, debouncedSearch, types, installedParam, filenamesParam,
      civitaiTypes, civitaiBaseModels, civitaiNsfw, civitaiPeriod, civitaiSort,
    ],
  );
  const paged = usePaginated<PageRow>(fetcher, {
    deps: [
      source, debouncedSearch, types, installedParam, filenamesParam,
      civitaiTypesKey, civitaiBaseModelsKey, civitaiNsfw, civitaiPeriod, civitaiSort,
    ],
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
  }, [
    source, debouncedSearch, types, installedParam,
    civitaiTypesKey, civitaiBaseModelsKey, civitaiNsfw, civitaiPeriod, civitaiSort,
  ]);
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

  // Client-side artifact filter on civitai rows. CivitAI's /models endpoint
  // returns hits that aren't directly downloadable as a model (training data
  // archives, accompanying images, config zips). The download path can't do
  // anything sensible with those, so drop them up front and surface a small
  // muted line about the hidden count.
  const CIVITAI_KEEP_FILE_TYPES = new Set(['Model', 'Pruned Model', 'VAE']);
  const CIVITAI_KEEP_EXTENSIONS = new Set([
    'safetensors', 'ckpt', 'pt', 'bin', 'gguf', 'onnx', 'pth',
  ]);
  const civitaiFilteredRows = useMemo<{ rows: PageRow[]; hidden: number }>(() => {
    if (source !== 'civitai') return { rows: pageRows, hidden: 0 };
    let hidden = 0;
    const kept: PageRow[] = [];
    for (const row of pageRows) {
      if (row.kind !== 'civitai') { kept.push(row); continue; }
      const file = row.item.modelVersions?.[0]?.files?.[0];
      const fileType = (file?.type ?? '').trim();
      const ext = (file?.name ?? '').split('.').pop()?.toLowerCase() ?? '';
      const okType = fileType.length === 0 || CIVITAI_KEEP_FILE_TYPES.has(fileType);
      const okExt = ext.length === 0 || CIVITAI_KEEP_EXTENSIONS.has(ext);
      if (okType && okExt) { kept.push(row); } else { hidden++; }
    }
    return { rows: kept, hidden };
    // CIVITAI_KEEP_* are module-stable Sets declared just above; the only
    // input that can change is pageRows + source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageRows, source]);
  const visiblePageRows = civitaiFilteredRows.rows;
  const civitaiHiddenCount = civitaiFilteredRows.hidden;

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

  // Refetch the visible page when the enrichment layer finishes a model.
  // Debounced (250ms trailing) because the hash queue often fires many
  // model:enriched events in quick succession — one fetch covers them all.
  useEffect(() => {
    let timer: number | null = null;
    const onEnriched = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => { refetchPageRef.current?.(); }, 250);
    };
    window.addEventListener('model:enriched', onEnriched);
    return () => {
      window.removeEventListener('model:enriched', onEnriched);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

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
    // Route multi-file HF repos through the snapshot-download path; the
    // single-URL walker only fetches one shard which is useless on its own
    // (downloaded shard 1 of ACE-Step captioner from the wrong repo earlier).
    if (model.hfRepo) {
      await api.downloadHfRepo(model.hfRepo, dir, model.name);
    } else if (model.url) {
      // Pass `type` in meta so the server's `prepopulateCatalog` writes the
      // right `type` field on the catalog row — without it, the row gets
      // `type: 'other'` and the canonicalize gate's save_path validation
      // (which needs a real type to look up registered folders) can't
      // correct a bad save_path. Result was the catalog persisting weird
      // values like `unet_gguf` even after the validation fix.
      await api.downloadCustomModel(model.url, dir, {
        modelName: model.name,
        filename: model.filename,
        meta: { type: model.type },
      });
    } else {
      // No URL and no HF repo — can't fetch bytes. Surface a clear error
      // instead of calling a dead endpoint.
      throw new Error(`No download URL for ${model.name}. Add a URL to the catalog row or paste one manually.`);
    }
  }, []);

  const handleInstall = useCallback(async (item: ModelRowItem) => {
    try {
      if (item.kind === 'civitai') {
        // Mirror CivitaiCard.handleDownload: resolve the primary file, map
        // civitai type -> comfyui dir, pre-populate catalog meta so the row
        // starts showing progress immediately.
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
          const dir = civitaiTypeToDirMap[civItem.type ?? ''] || 'checkpoints';
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
      const typeDerived = typeToDirMap[model.type];
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
  }, [installCatalogWithDir, typeToDirMap, civitaiTypeToDirMap]);

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
      // Pass the (save_path, filename) pair — collision-free, no name lookup.
      // Falls back to `modelName` if either field is missing on the catalog row.
      await api.deleteModel(
        deleteTarget.save_path && deleteTarget.filename
          ? { save_path: deleteTarget.save_path, filename: deleteTarget.filename }
          : { modelName: deleteTarget.name },
      );
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

  // The visible grid is now server-filtered when a template is picked
  // (`filenamesParam` narrows the catalog query). `workflowRequired` still
  // drives the `isRequired` badge so the row labelling stays consistent.
  // The dependency modal remains the canonical place for the FULL list
  // including download buttons for models not yet in the catalog.
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
      : tab === 'recipes'
      ? 'Saved LoRA combinations'
      : `${stats?.available ?? 0} total, ${installedCount} installed`;

  return (
    <>
      <PageSubbar
        title="Models"
        description={subbarDescription}
        right={
          tab === 'models' ? (
            <div className="flex items-center gap-2">
              {/* Bulk enrich — only meaningful for the local catalog tab; the
                  CivitAI search tab and Ollama tab don't have local sidecars
                  to populate. Hash queue + per-model enrich runs in the
                  background; toast confirms enqueue count. */}
              {source === 'local' && (
                <Button
                  onClick={handleEnrichAll}
                  variant="secondary"
                  disabled={enrichAllBusy}
                  aria-label="Enrich all installed models from CivitAI / HuggingFace"
                  title="Enrich all installed models from CivitAI / HuggingFace"
                >
                  {enrichAllBusy
                    ? <Spinner size="xs" />
                    : <Sparkles className="w-3.5 h-3.5" />}
                  <span className="hidden sm:inline">Enrich all</span>
                </Button>
              )}
              <Button
                onClick={() => setFiltersOpen(o => !o)}
                variant="secondary"
                className="lg:hidden"
                aria-label="Toggle filters"
              >
                <SlidersHorizontal className="w-3.5 h-3.5" />
                Filters
              </Button>
            </div>
          ) : null
        }
      />
      <div className="flex flex-col lg:flex-row gap-4 p-4">
        {/* ===== Left aside (Models tab + Comfy-side sources only).
            Ollama is its own top-level template — driven by the sidebar's
            Comfy/Ollama submenu — and its panel owns its sub-navigation,
            so we skip the aside entirely when source === 'ollama'. */}
        {tab === 'models' && source !== 'ollama' && (
          <PageAside open={filtersOpen} className="p-4 space-y-5 overflow-y-auto">
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
                    {/* Ollama is reached via the sidebar submenu now — it's
                        its own top-level template (no aside, no shared
                        source picker). HuggingFace is a placeholder for a
                        future Comfy-side source. */}
                    <SelectItem value="huggingface" disabled>HuggingFace (coming soon)</SelectItem>
                  </SelectContent>
                </SelectField>
              </div>

              {/* CivitAI filter sidebar — vocabulary is fetched dynamically
                  from /civitai/models/facets so chip lists are never
                  hardcoded here. Only visible when source === 'civitai'. */}
              {source === 'civitai' && (
                <CivitaiFilterSidebar
                  facets={facets}
                  loading={facetsLoading}
                  types={civitaiTypes}
                  baseModels={civitaiBaseModels}
                  nsfw={civitaiNsfw}
                  period={civitaiPeriod}
                  sort={civitaiSort}
                  onTypesChange={setCivitaiTypes}
                  onBaseModelsChange={setCivitaiBaseModels}
                  onNsfwChange={setCivitaiNsfw}
                  onPeriodChange={setCivitaiPeriod}
                  onSortChange={setCivitaiSort}
                />
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
                            className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none hover:text-foreground"
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

              {/* Storage Summary — local catalog stats (this aside is already
                  skipped for Ollama, whose numbers come from `ollama list`). */}
              <div className="pt-4 border-t">
                <label className="field-label mb-2 block">Storage</label>
                <div className="divide-y rounded-lg ring-1 ring-inset ring-border/60 overflow-hidden bg-card">
                  <div className="flex items-center gap-2 px-3 py-2">
                    <CheckCircle2 className="w-4 h-4 text-success shrink-0" />
                    <span className="text-xs text-muted-foreground flex-1">Installed</span>
                    <span className="font-mono text-sm font-semibold text-foreground">{installedCount}</span>
                  </div>
                  <div className="flex items-center gap-2 px-3 py-2">
                    <Package className="w-4 h-4 text-muted-foreground shrink-0" />
                    <span className="text-xs text-muted-foreground flex-1">Available</span>
                    <span className="font-mono text-sm font-semibold text-foreground">{stats?.available ?? 0}</span>
                  </div>
                  <div className="flex items-center gap-2 px-3 py-2">
                    <HardDrive className="w-4 h-4 text-brand shrink-0" />
                    <span className="text-xs text-muted-foreground flex-1">Disk usage</span>
                    <span className="font-mono text-sm font-semibold text-foreground">{formatBytes(totalDiskSize)}</span>
                  </div>
                </div>
              </div>
          </PageAside>
        )}

        {/* ===== Right content. No outer card wrapper — page rows already
            render their own cards/panels and a card-in-card looks heavy. */}
        <section className="flex flex-1 min-w-0 flex-col">
          <div className="flex-1">
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
                      <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
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
                          className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
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
                  <button
                    role="tab"
                    aria-selected={tab === 'recipes'}
                    onClick={() => setTab('recipes')}
                    className={`tab-strip-item ${tab === 'recipes' ? 'is-active' : ''}`}
                  >
                    Recipes
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
                    className="tab-strip-item text-brand hover:opacity-80 hover:bg-brand/10 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${rescanning ? 'animate-spin' : ''}`} />
                    {rescanning ? 'Rescanning…' : 'Rescan'}
                  </button>
                </div>
              </div>

              {tab === 'downloads' ? (
                <DownloadsTab />
              ) : tab === 'recipes' ? (
                <RecipesPanel />
              ) : (
              <>
              {/* Download All Missing banner — local catalog only. */}
              {source === 'local' && selectedWorkflow && missingInFilter > 0 && (
                <div className="flex items-center justify-between p-3 bg-warning/10 border border-warning/30 rounded-lg mb-4">
                  <span className="text-sm text-warning">
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
                  <div className="divide-y">
                    {[0, 1, 2, 3, 4, 5].map((i) => (
                      <div key={`sk-${i}`} className="flex items-center gap-3 py-2.5 px-4">
                        <div className="w-8 h-8 rounded bg-muted animate-pulse shrink-0" />
                        <div className="flex-1 min-w-0 space-y-1.5">
                          <div className="h-3 w-1/2 rounded bg-muted animate-pulse" />
                          <div className="h-2.5 w-1/3 rounded bg-muted animate-pulse" />
                        </div>
                        <div className="h-7 w-20 rounded bg-muted animate-pulse shrink-0" />
                      </div>
                    ))}
                  </div>
                </Card>
              ) : source === 'local' && filteredModels.length > 0 ? (
                <Card>
                  <div className="divide-y">
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
              ) : source === 'civitai' && visiblePageRows.length > 0 ? (
                <Card>
                  <div className="divide-y">
                    {visiblePageRows.map((row, i) => {
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
                    (() => {
                      const noQuery = !search.trim();
                      const noFilter =
                        civitaiTypes.length === 0
                        && civitaiBaseModels.length === 0
                        && !civitaiNsfw;
                      // Only show "type a query" when every input is empty.
                      // If filters are set OR NSFW is on, treat as "searching"
                      // — empty-state is "no results", not a prompt to type.
                      if (noQuery && noFilter) {
                        return (
                          <>
                            <Search className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
                            <p className="text-sm font-medium text-muted-foreground">
                              Search CivitAI
                            </p>
                            <p className="text-xs text-muted-foreground mt-1">
                              Type a query or pick a filter to start.
                            </p>
                          </>
                        );
                      }
                      return (
                        <>
                          <Box className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
                          <p className="text-sm font-medium text-muted-foreground">
                            {search.trim() ? `No results for "${search}"` : 'No CivitAI models match these filters.'}
                          </p>
                          <p className="text-xs text-muted-foreground mt-1">
                            Try a different query or relax a filter.
                          </p>
                        </>
                      );
                    })()
                  ) : !connected ? (
                    <>
                      <WifiOff className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
                      <p className="text-sm font-medium text-muted-foreground">Connect to ComfyUI to manage models</p>
                      <p className="text-xs text-muted-foreground mt-1 mb-4">Models will appear once the connection is established</p>
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
                      <Box className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
                      <p className="text-sm font-medium text-muted-foreground">No models found</p>
                      <p className="text-xs text-muted-foreground mt-1">The launcher may not be available</p>
                    </>
                  ) : (
                    <>
                      <Box className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
                      <p className="text-sm text-muted-foreground">No models match your filters</p>
                      <button
                        onClick={clearFilters}
                        className="text-xs text-brand hover:opacity-80 mt-2"
                      >
                        Clear filters
                      </button>
                    </>
                  )}
                </div>
              )}

              {/* Hidden-row note — surfaced only when the artifact filter
                  actually dropped something so the user understands the
                  apparent under-count between page size + visible rows. */}
              {source === 'civitai' && civitaiHiddenCount > 0 && (
                <p className="mt-2 text-xs text-muted-foreground italic">
                  {civitaiHiddenCount} hidden — not downloadable as a model
                </p>
              )}

              {/* CivitAI: infinite-scroll sentinel. CivitAI's API doesn't
                  ship a usable `total`, so numbered pagination isn't an
                  option here — keep "Load more" via the
                  IntersectionObserver above. */}
              {source === 'civitai' && visiblePageRows.length > 0 && (
                <div
                  ref={sentinelRef}
                  className="mt-4 rounded-lg border bg-muted px-4 py-3 flex items-center justify-center"
                >
                  {paged.hasMore ? (
                    <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                      {loading && <Spinner size="sm" />}
                      {loading ? 'Loading more…' : 'Scroll to load more'}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">No more results</span>
                  )}
                </div>
              )}

              {/* Local catalog: numbered Pagination — page-replace, jump-by-page,
                  page-size select. Hidden when a workflow filter is active
                  (the required-model list is a fixed set, paging would just
                  hide rows the user picked the workflow to surface). */}
              {source === 'local' && !selectedWorkflow && paged.total > 0 && (
                <Pagination
                  page={paged.page}
                  pageSize={paged.pageSize}
                  total={paged.total}
                  hasMore={paged.hasMore}
                  onPageChange={paged.setPage}
                  onPageSizeChange={paged.setPageSize}
                />
              )}
              </>
              )}
              </>
              )}
          </div>
        </section>
      </div>

      <ModelInfoModal
        open={!!infoSource}
        onClose={() => setInfoSource(null)}
        source={infoSource}
      />

      <ModelFolderPickerModal
        open={!!folderPickModel}
        modelName={folderPickModel?.filename || folderPickModel?.name || ''}
        preferred={folderPickModel ? typeToDirMap[folderPickModel.type] : undefined}
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
