// Ollama-source pane for the Models page. Replaces the now-removed
// `/chat/models` page; mounted by `pages/Models.tsx` when
// `source === 'ollama'`.
//
// Three sub-tabs (Installed, Ollama Library, HuggingFace) mirror the
// previous ChatModels layout. The tab grids each live in `./ollama/*`
// (250-line cap per file); this orchestrator owns state + the WS-driven
// pulls map + the shared ConfirmDialog. Cards forward Pull / Cancel /
// Delete intents back up by name.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  api, type OllamaInstalledModel, type OllamaLibraryModel, type HfModelSummary,
} from '../services/comfyui';
import { usePersistedState } from '../hooks/usePersistedState';
import { usePaginated } from '../hooks/usePaginated';
import ConfirmDialog from './modals/ConfirmDialog';
import { InstalledTab } from './ollama/InstalledTab';
import { LibraryTab } from './ollama/LibraryTab';
import { HuggingFaceTab } from './ollama/HuggingFaceTab';
import { PanelToolbar, type OllamaPanelTab } from './ollama/PanelToolbar';
import { useOllamaPulls } from './ollama/useOllamaPulls';
import Pagination from './layout/Pagination';

export default function OllamaModelsPanel() {
  // Persisted: active tab + last HF/library search queries + per-card tag
  // selection. Mirrors the Models + Explore pages, which persist their own
  // state via `usePersistedState` so a reload restores where the user was.
  const [tab, setTab] = usePersistedState<OllamaPanelTab>('models.ollama.tab', 'installed');
  const [hfQuery, setHfQuery] = usePersistedState<string>('models.ollama.hfQuery', '');
  const [libraryQuery, setLibraryQuery] = usePersistedState<string>('models.ollama.libraryQuery', '');
  const [librarySelectedTag, setLibrarySelectedTag] = usePersistedState<Record<string, string>>(
    'models.ollama.libraryTag',
    {},
  );

  const [installed, setInstalled] = useState<OllamaInstalledModel[]>([]);
  const [hf, setHf] = useState<HfModelSummary[]>([]);
  // Debounced mirror of `hfQuery` — matches the Models/Explore pattern so
  // search auto-fires 350ms after the last keystroke (no Search button).
  // Initialised to the persisted query so a reload restores results without
  // the 350ms debounce penalty.
  const [debouncedHfQuery, setDebouncedHfQuery] = useState(hfQuery);
  const [debouncedLibraryQuery, setDebouncedLibraryQuery] = useState(libraryQuery);
  const [hfBusy, setHfBusy] = useState(false);
  const [loadingTab, setLoadingTab] = useState(false);

  // Library-tab pagination via the shared `usePaginated` hook — gives URL
  // sync (?page=&pageSize=) and global pageSize persistence. The fetcher
  // short-circuits when the active tab isn't `library` so switching to
  // `installed` / `huggingface` doesn't waste an upstream call.
  const libraryFetcher = useCallback(async ({ page, pageSize }: { page: number; pageSize: number }) => {
    if (tab !== 'library') return { items: [], total: 0, hasMore: false };
    const { items, total } = await api.chat.listLibrary({
      q: debouncedLibraryQuery || undefined,
      page,
      pageSize,
    });
    return { items, total, hasMore: page * pageSize < total };
  }, [tab, debouncedLibraryQuery]);
  const libraryPaged = usePaginated<OllamaLibraryModel>(libraryFetcher, {
    deps: [tab, debouncedLibraryQuery],
    initialPageSize: 25,
  });

  const refreshInstalled = useCallback(() => {
    setLoadingTab(true);
    api.chat.listInstalledModels()
      .then(({ models }) => setInstalled(Array.isArray(models) ? models : []))
      .catch((err) => {
        toast.error('Failed to load installed models', {
          description: err instanceof Error ? err.message : String(err),
        });
        setInstalled([]);
      })
      .finally(() => setLoadingTab(false));
  }, []);

  // Force-rescrape upstream (POST /refresh) then re-list page 1. Triggered
  // from the Refresh button while the Library tab is active so the user
  // has an explicit way to pick up new models without waiting on a TTL.
  const forceRefreshLibrary = useCallback(async () => {
    setLoadingTab(true);
    try {
      await api.chat.refreshLibrary();
      libraryPaged.setPage(1);
      await libraryPaged.refetch();
    } catch (err) {
      toast.error('Failed to refresh Ollama library', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoadingTab(false);
    }
  }, [libraryPaged]);

  // Cards on every tab need to know which models are already installed
  // (Installed badge + Pull-button gate). Load the installed list once on
  // mount so the Library / HuggingFace tabs reflect state even if the user
  // lands there before visiting Installed.
  useEffect(() => { refreshInstalled(); }, [refreshInstalled]);

  // Pull lifecycle (WS-driven progress + start/cancel) lives in a hook so
  // the panel stays focused on tab/state orchestration.
  const { pulls, handlePull, handleCancel } = useOllamaPulls(refreshInstalled);

  // Delete confirm — opened from the per-row Trash button on the
  // installed-models tab AND from the HF tab when a model is already
  // present locally. ConfirmDialog runs the actual deletion via `runDelete`.
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const runDelete = async () => {
    if (!deleteTarget) return;
    const name = deleteTarget;
    try {
      await api.chat.deleteModel(name);
      toast.success(`Deleted ${name}`);
      refreshInstalled();
    } catch (err) {
      toast.error('Failed to delete', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setDeleteTarget(null);
    }
  };

  // Debounce hfQuery → debouncedHfQuery (350ms idle).
  useEffect(() => {
    const t = setTimeout(() => setDebouncedHfQuery(hfQuery), 350);
    return () => clearTimeout(t);
  }, [hfQuery]);

  // Same debounce for the library search box. `usePaginated` resets page→1
  // automatically when the debounced query changes (it's in `deps`).
  useEffect(() => {
    const t = setTimeout(() => setDebouncedLibraryQuery(libraryQuery), 350);
    return () => clearTimeout(t);
  }, [libraryQuery]);

  // Auto-fetch HF results when the debounced query changes. Empty query
  // clears the result list — no search button needed.
  useEffect(() => {
    if (tab !== 'huggingface') return;
    const q = debouncedHfQuery.trim();
    if (!q) { setHf([]); return; }
    let cancelled = false;
    setHfBusy(true);
    api.chat.searchHf(q)
      .then(({ items }) => { if (!cancelled) setHf(items); })
      .catch((err) => {
        if (cancelled) return;
        toast.error('HF search failed', {
          description: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => { if (!cancelled) setHfBusy(false); });
    return () => { cancelled = true; };
  }, [debouncedHfQuery, tab]);

  // Manual refresh — re-runs the active tab's fetch. For HF, just re-trigger
  // the debounced query (toggle through state).
  const handleHfRefresh = () => {
    const q = debouncedHfQuery;
    setDebouncedHfQuery('');
    setTimeout(() => setDebouncedHfQuery(q), 0);
  };

  const onRefresh = tab === 'installed'
    ? refreshInstalled
    : tab === 'library' ? forceRefreshLibrary : handleHfRefresh;
  const refreshing = loadingTab || libraryPaged.loading || hfBusy;

  return (
    <div className="space-y-3">
      <PanelToolbar
        tab={tab}
        setTab={setTab}
        installedCount={installed.length}
        libraryQuery={libraryQuery}
        setLibraryQuery={setLibraryQuery}
        hfQuery={hfQuery}
        setHfQuery={setHfQuery}
        refreshing={refreshing}
        onRefresh={onRefresh}
      />

      {tab === 'installed' && (
        <InstalledTab
          loading={loadingTab}
          installed={installed}
          onRequestDelete={setDeleteTarget}
        />
      )}

      {tab === 'library' && (
        <>
          <LibraryTab
            loading={loadingTab || libraryPaged.loading}
            items={libraryPaged.items}
            installed={installed}
            pulls={pulls}
            debouncedLibraryQuery={debouncedLibraryQuery}
            librarySelectedTag={librarySelectedTag}
            setLibrarySelectedTag={setLibrarySelectedTag}
            handlePull={handlePull}
            handleCancel={handleCancel}
          />
          <Pagination
            page={libraryPaged.page}
            pageSize={libraryPaged.pageSize}
            total={libraryPaged.total}
            hasMore={libraryPaged.hasMore}
            onPageChange={libraryPaged.setPage}
            onPageSizeChange={libraryPaged.setPageSize}
          />
        </>
      )}

      {tab === 'huggingface' && (
        <HuggingFaceTab
          hf={hf}
          hfBusy={hfBusy}
          hfQuery={hfQuery}
          installed={installed}
          pulls={pulls}
          handlePull={handlePull}
          handleCancel={handleCancel}
          onRequestDelete={setDeleteTarget}
        />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Delete model?"
        description={deleteTarget ? `This will remove "${deleteTarget}" from the local Ollama installation. You can re-pull it from the Library tab.` : ''}
        confirmLabel="Delete"
        confirmTone="danger"
        onConfirm={runDelete}
      />
    </div>
  );
}
