import { useMemo, useEffect, useCallback, useState, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Search, Layers, WifiOff, Settings, SlidersHorizontal, X, RefreshCw, Upload, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import type { Template, CivitaiModelSummary, StagedImportManifest } from '../types';
import { api } from '../services/comfyui';
import { useApp } from '../context/AppContext';
import { usePersistedState } from '../hooks/usePersistedState';
import { usePaginated } from '../hooks/usePaginated';
import Pagination from '../components/Pagination';
import TemplateCard, { CivitaiTemplateCard } from '../components/TemplateCard';
import PageSubbar from '../components/PageSubbar';
import ImportWorkflowModal from '../components/ImportWorkflowModal';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Checkbox } from '../components/ui/checkbox';

type ReadyFilter = 'all' | 'yes' | 'no';
type SourceFilter = 'all' | 'open' | 'api' | 'user' | 'civitai';
type CivitaiFeed = 'latest' | 'hot' | 'search';

// Fixed page size for the civitai feed — pageSize selector is part of the
// legacy Pagination widget which doesn't apply to the "Load more" UX.
const CIVITAI_PAGE_SIZE = 24;

// Shared row type for the server-paginated grid. Keeps one fetcher path and
// lets `TemplateCard` / `CivitaiTemplateCard` render side-by-side without
// breaking pagination alignment.
type ExploreRow =
  | { kind: 'template'; template: Template }
  | { kind: 'civitai'; item: CivitaiModelSummary };

const categories = ['All', 'Use Cases', 'Image', 'Video', 'Audio', '3D Model', 'LLM', 'Utility', 'Getting Started'];

export default function Explore() {
  const { templates, connected, refreshTemplates, apiKeyConfigured } = useApp();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  useEffect(() => {
    refreshTemplates();
  }, [refreshTemplates]);
  const [activeCategory, setActiveCategory] = usePersistedState('explore.category', 'All');
  const [searchQuery, setSearchQuery] = usePersistedState('explore.search', '');
  // Debounced mirror of searchQuery used for the actual fetch. Without this,
  // every keystroke triggers a civitai round-trip + 24 image swaps → jank.
  const [debouncedSearch, setDebouncedSearch] = useState(searchQuery);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery), 350);
    return () => clearTimeout(t);
  }, [searchQuery]);
  const [activeTags, setActiveTags] = usePersistedState<string[]>('explore.tags', []);
  const [filtersOpen, setFiltersOpen] = usePersistedState('explore.filtersOpen', false);
  const [sourceFilter, setSourceFilter] = usePersistedState<SourceFilter>('explore.source', 'all');
  const [readyFilter, setReadyFilter] = usePersistedState<ReadyFilter>('explore.ready', 'all');
  const [importOpen, setImportOpen] = useState(false);
  const [importInitialManifest, setImportInitialManifest] = useState<StagedImportManifest | null>(null);

  // Allow `?source=civitai` deep-links (used by the legacy
  // /plugins/civitai/workflows redirect) to prime the Source filter once.
  const urlSource = searchParams.get('source');
  useEffect(() => {
    if (urlSource === 'civitai' && sourceFilter !== 'civitai') {
      setSourceFilter('civitai');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlSource]);

  const [refreshing, setRefreshing] = useState(false);

  // CivitAI-only: feed selector + accumulator state used with the "Load more"
  // button. Civitai doesn't return totals, so numbered pagination can't work;
  // we keep rows in local state and fetch incrementally instead.
  const [civitaiFeed, setCivitaiFeed] = usePersistedState<CivitaiFeed>('explore.civitaiFeed', 'latest');
  const [civRows, setCivRows] = useState<CivitaiModelSummary[]>([]);
  const [civPage, setCivPage] = useState(1);
  const [civCursor, setCivCursor] = useState<string | undefined>(undefined);
  const [civHasMore, setCivHasMore] = useState(false);
  const [civLoading, setCivLoading] = useState(false);
  const [civError, setCivError] = useState<string | null>(null);
  const civReqRef = useRef(0);

  // Server-paginated fetch for non-civitai sources. When civitai is active
  // we skip this fetcher entirely (return an empty envelope) and use the
  // separate Load-more accumulator below.
  const fetcher = useCallback(
    async ({ page, pageSize }: { page: number; pageSize: number }) => {
      if (sourceFilter === 'civitai') {
        return { items: [] as ExploreRow[], total: 0, hasMore: false };
      }
      // Forward the UI source enum straight through — the backend understands
      // `open` / `api` / `user`, and ignores `all`.
      const backendSource =
        sourceFilter === 'all' ? undefined
        : sourceFilter === 'user' ? 'user'
        : sourceFilter;
      const res = await api.getTemplatesPaged(page, pageSize, {
        q: debouncedSearch.trim() || undefined,
        category: activeCategory,
        tags: activeTags.length > 0 ? activeTags : undefined,
        source: backendSource,
        ready: readyFilter,
      });
      return {
        items: res.items.map<ExploreRow>((template) => ({ kind: 'template', template })),
        total: res.total,
        hasMore: res.hasMore,
      };
    },
    [debouncedSearch, activeCategory, activeTags, sourceFilter, readyFilter],
  );
  const paged = usePaginated<ExploreRow>(fetcher, {
    deps: [debouncedSearch, activeCategory, activeTags, sourceFilter, readyFilter],
  });
  const { refetch } = paged;

  // Fetch the next civitai page. Called on initial mount (via the reset
  // effect), on Load more clicks, and on feed/search changes. Request tokens
  // via `civReqRef` so out-of-order responses are discarded.
  const fetchCivitaiPage = useCallback(
    async (args: { feed: CivitaiFeed; page: number; query: string; cursor?: string; append: boolean }) => {
      const token = ++civReqRef.current;
      setCivLoading(true);
      setCivError(null);
      try {
        let res;
        if (args.feed === 'search') {
          const trimmed = args.query.trim();
          if (!trimmed) {
            // Nothing to search for — clear and bail so the empty-state
            // branch renders the "enter a query" hint.
            if (token === civReqRef.current) {
              setCivRows([]);
              setCivHasMore(false);
              setCivCursor(undefined);
            }
            return;
          }
          res = await api.searchCivitai(trimmed, args.cursor, CIVITAI_PAGE_SIZE);
        } else if (args.feed === 'hot') {
          res = await api.getCivitaiHot(args.page, CIVITAI_PAGE_SIZE, args.cursor);
        } else {
          res = await api.getCivitaiLatest(args.page, CIVITAI_PAGE_SIZE, args.cursor);
        }
        if (token !== civReqRef.current) return;
        setCivRows((prev) => (args.append ? [...prev, ...res.items] : res.items));
        setCivHasMore(res.hasMore);
        setCivCursor(res.nextCursor);
      } catch (err) {
        if (token !== civReqRef.current) return;
        const msg = err instanceof Error ? err.message : 'Failed to fetch CivitAI feed';
        setCivError(msg);
        // Parse HTTP status from the error text so we can frame 401 etc.
        // with a clearer toast description (spec #1 requirement).
        const statusMatch = /\b(\d{3})\b/.exec(msg);
        const status = statusMatch ? Number(statusMatch[1]) : null;
        if (status === 401) {
          toast.error('CivitAI download failed', {
            description: '401 Unauthorized. The model may require an API token or a logged-in session.',
          });
        } else {
          toast.error('CivitAI feed error', { description: msg });
        }
      } finally {
        if (token === civReqRef.current) setCivLoading(false);
      }
    },
    [],
  );

  // Reset + refetch whenever the civitai feed axis changes (source toggled,
  // feed selector changed, debounced search changed for search mode).
  useEffect(() => {
    if (sourceFilter !== 'civitai') return;
    setCivRows([]);
    setCivPage(1);
    setCivCursor(undefined);
    setCivHasMore(false);
    void fetchCivitaiPage({
      feed: civitaiFeed,
      page: 1,
      query: debouncedSearch,
      cursor: undefined,
      append: false,
    });
  }, [sourceFilter, civitaiFeed, debouncedSearch, fetchCivitaiPage]);

  const handleCivitaiLoadMore = useCallback(() => {
    if (civLoading || !civHasMore) return;
    const nextPage = civPage + 1;
    setCivPage(nextPage);
    void fetchCivitaiPage({
      feed: civitaiFeed,
      page: nextPage,
      query: debouncedSearch,
      cursor: civCursor,
      append: true,
    });
  }, [civLoading, civHasMore, civPage, civitaiFeed, debouncedSearch, civCursor, fetchCivitaiPage]);

  // Final row list the grid renders. Non-civitai sources use the paginated
  // hook; civitai uses the accumulator.
  const gridRows: ExploreRow[] = useMemo(() => {
    if (sourceFilter === 'civitai') {
      return civRows.map<ExploreRow>((item) => ({ kind: 'civitai', item }));
    }
    return paged.items;
  }, [sourceFilter, civRows, paged.items]);

  const handleTemplateDeleted = useCallback(
    async (name: string) => {
      toast.success(`Template "${name}" removed.`);
      await refetch();
      await refreshTemplates();
    },
    [refetch, refreshTemplates],
  );

  const handleImportOpen = useCallback((manifest?: StagedImportManifest | null): void => {
    setImportInitialManifest(manifest ?? null);
    setImportOpen(true);
  }, []);

  const handleImportClose = useCallback((): void => {
    setImportOpen(false);
    setImportInitialManifest(null);
  }, []);

  const handleImported = useCallback(async (imported: string[]): Promise<void> => {
    toast.success(
      imported.length === 1
        ? 'Imported 1 template.'
        : `Imported ${imported.length} templates.`,
    );
    setImportOpen(false);
    setImportInitialManifest(null);
    // Favour the "user imported" source so the newly added rows are visible.
    setSourceFilter('user');
    await refetch();
    await refreshTemplates();
  }, [refetch, refreshTemplates, setSourceFilter]);

  const handleRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const result = await api.refreshTemplates();
      toast.success('Templates refreshed', {
        description: `Added ${result.added}, updated ${result.updated}, removed ${result.removed}.`,
      });
      await refetch();
    } catch (err) {
      toast.error('Refresh failed', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRefreshing(false);
    }
  }, [refreshing, refetch]);

  // Tag options + category counts still derive from the bootstrap templates
  // cached in AppContext (the full list was loaded once for the workflow
  // dropdowns). Keeps the sidebar stable across pages.
  const tagOptions = useMemo(() => {
    const tagCounts = new Map<string, number>();
    templates.forEach(t => {
      t.tags.forEach(tag => {
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      });
    });
    return Array.from(tagCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([tag]) => tag);
  }, [templates]);

  const toggleTag = (tag: string) => {
    setActiveTags(prev =>
      prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]
    );
  };

  // Count templates per category
  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    counts.set('All', templates.length);
    templates.forEach(t => {
      counts.set(t.category, (counts.get(t.category) || 0) + 1);
    });
    return counts;
  }, [templates]);

  const hasActiveFilters =
    activeCategory !== 'All' ||
    !!searchQuery ||
    activeTags.length > 0 ||
    sourceFilter !== 'all' ||
    readyFilter !== 'all';

  return (
    <>
      <PageSubbar
        title="Explore"
        description={`${templates.length} workflows available`}
        right={
          <div className="flex items-center gap-2">
            <div className="btn-group">
              <button
                onClick={() => handleImportOpen(null)}
                className="btn-primary"
                aria-label="Import workflow"
                title="Import a workflow from a .json or .zip file"
              >
                <Upload className="w-3.5 h-3.5" />
                Import workflow
              </button>
              <button
                onClick={handleRefresh}
                disabled={refreshing}
                className="btn-secondary"
                aria-label="Refresh templates"
                title="Re-pull template catalog from ComfyUI and recompute readiness"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                {refreshing ? 'Refreshing...' : 'Refresh'}
              </button>
            </div>
            <button
              onClick={() => setFiltersOpen(o => !o)}
              className="btn-secondary lg:hidden"
              aria-label="Toggle filters"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              Filters
            </button>
          </div>
        }
      />
      <div className="page-container">
        <div className="panel">
          <div className="flex flex-col lg:flex-row min-h-[calc(100vh-180px)]">
            {/* ===== Left sidebar ===== */}
            <aside className={`${filtersOpen ? 'block' : 'hidden'} lg:block w-full lg:w-72 shrink-0 border-b lg:border-b-0 lg:border-r border-slate-200 p-4 space-y-5 bg-white`}>
              {/* Search + Ready-to-use moved to the main-pane toolbar below,
                  mirroring the Models page layout (search as a flex-1 input,
                  filter as a right-aligned tab strip). Keeps the sidebar
                  focused on taxonomy (Source / Feed / Tags / Stats). */}

              {/* Source — always shown now. User imported + CivitAI don't
                  require an API key; only the `api` option does. */}
              <div>
                <label className="field-label mb-1.5 block">Source</label>
                <Select value={sourceFilter} onValueChange={(v) => setSourceFilter(v as SourceFilter)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="open">ComfyUI (open source)</SelectItem>
                    {apiKeyConfigured && (
                      <SelectItem value="api">API (external providers)</SelectItem>
                    )}
                    <SelectItem value="user">User imported</SelectItem>
                    <SelectItem value="civitai">CivitAI</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Feed — civitai only. Swaps between Latest / Hot / Search
                  since civitai doesn't return totals and the numbered
                  Pagination widget can't drive it. */}
              {sourceFilter === 'civitai' && (
                <div>
                  <label className="field-label mb-1.5 block">Feed</label>
                  <Select value={civitaiFeed} onValueChange={(v) => setCivitaiFeed(v as CivitaiFeed)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="latest">Latest</SelectItem>
                      <SelectItem value="hot">Hot</SelectItem>
                      <SelectItem value="search">Search</SelectItem>
                    </SelectContent>
                  </Select>
                  {civitaiFeed === 'search' && !debouncedSearch.trim() && (
                    <p className="mt-1.5 text-[11px] text-slate-500">
                      Type a query in the Search box above to run a CivitAI search.
                    </p>
                  )}
                </div>
              )}

              {/* Ready-to-use moved to the main-pane toolbar as a tab strip
                  (matches the Models page pattern). */}

              {/* Category — local templates only. CivitAI exposes its own
                  taxonomy we don't map through. */}
              {sourceFilter !== 'civitai' && (
                <div>
                  <label className="field-label mb-1.5 block">Category</label>
                  <Select value={activeCategory} onValueChange={setActiveCategory}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {categories.map(cat => {
                        const count = categoryCounts.get(cat) || 0;
                        if (cat !== 'All' && count === 0) return null;
                        return (
                          <SelectItem key={cat} value={cat}>
                            {cat} {count > 0 && <span className="text-slate-400">({count})</span>}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* Tags — local templates only. */}
              {sourceFilter !== 'civitai' && tagOptions.length > 0 && (
                <div>
                  <label className="field-label mb-1.5 block">Tags</label>
                  <div className="space-y-1.5 max-h-64 overflow-y-auto">
                    {tagOptions.map(tag => (
                      <label
                        key={tag}
                        className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer select-none hover:text-slate-900"
                      >
                        <Checkbox
                          checked={activeTags.includes(tag)}
                          onCheckedChange={() => toggleTag(tag)}
                        />
                        {tag}
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {/* Stats — vertical row list, matches Models page's Storage
                  panel language (icon + label left, value right-aligned). */}
              <div className="pt-4 border-t border-slate-200">
                <label className="field-label mb-2 block">Stats</label>
                <div className="divide-y divide-slate-100 rounded-lg ring-1 ring-inset ring-slate-200 overflow-hidden bg-white">
                  <div className="flex items-center gap-2 px-3 py-2">
                    <Layers className="w-4 h-4 text-slate-500 shrink-0" />
                    <span className="text-xs text-slate-600 flex-1">Total</span>
                    <span className="font-mono text-sm font-semibold text-slate-900">{templates.length}</span>
                  </div>
                  <div className="flex items-center gap-2 px-3 py-2">
                    <SlidersHorizontal className="w-4 h-4 text-teal-600 shrink-0" />
                    <span className="text-xs text-slate-600 flex-1">Filtered</span>
                    <span className="font-mono text-sm font-semibold text-slate-900">{paged.total}</span>
                  </div>
                </div>
              </div>

              {/* Clear filters */}
              <div className="pt-4 border-t border-slate-200">
                <button
                  onClick={() => { setActiveCategory('All'); setSearchQuery(''); setActiveTags([]); setSourceFilter('all'); setReadyFilter('all'); }}
                  className="btn-secondary w-full justify-center"
                  disabled={!hasActiveFilters}
                >
                  <X className="w-3.5 h-3.5" />
                  Clear Filters
                </button>
              </div>
            </aside>

            {/* ===== Right content ===== */}
            <main className="flex-1 p-4 overflow-y-auto">
              {/* Toolbar — search (always) + ready-to-use tab strip (local
                  sources only). Mirrors the Models page's top-bar layout:
                  flex-1 search input on the left, right-aligned tab-strip
                  for the secondary filter. */}
              <div className="flex flex-col md:flex-row md:items-center gap-2 mb-4">
                <div className="flex-1 field-wrap">
                  <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                  <input
                    type="text"
                    className="field-input"
                    placeholder="Search workflows..."
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                  />
                  {searchQuery !== '' && (
                    <button
                      type="button"
                      onClick={() => setSearchQuery('')}
                      aria-label="Clear search"
                      className="shrink-0 text-slate-400 hover:text-slate-700 transition-colors"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                {sourceFilter !== 'civitai' && (
                  <div
                    role="tablist"
                    aria-label="Ready to use filter"
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-1 shadow-sm self-start md:self-auto"
                  >
                    {(['all', 'yes', 'no'] as const).map(v => {
                      const labelMap = { all: 'All', yes: 'Ready', no: 'Missing' };
                      const active = readyFilter === v;
                      return (
                        <button
                          key={v}
                          role="tab"
                          aria-selected={active}
                          onClick={() => setReadyFilter(v)}
                          className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-semibold transition ${
                            active ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
                          }`}
                        >
                          {labelMap[v]}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {sourceFilter !== 'civitai' && templates.length === 0 ? (
                <div className="text-center py-20">
                  {!connected ? (
                    <>
                      <WifiOff className="w-10 h-10 text-slate-200 mx-auto mb-3" />
                      <p className="text-sm font-medium text-slate-500">Connect to ComfyUI to load workflows</p>
                      <p className="text-xs text-slate-400 mt-1 mb-4">Workflows will appear once ComfyUI is running</p>
                      <button
                        onClick={() => navigate('/settings')}
                        className="btn-secondary"
                      >
                        <Settings className="w-3.5 h-3.5" />
                        Check Settings
                      </button>
                    </>
                  ) : (
                    <>
                      <Layers className="w-10 h-10 text-slate-200 mx-auto mb-3" />
                      <p className="text-sm font-medium text-slate-500">No workflows available</p>
                      <p className="text-xs text-slate-400 mt-1">Start ComfyUI to load workflow templates</p>
                    </>
                  )}
                </div>
              ) : gridRows.length > 0 ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                  {gridRows.map((row) =>
                    row.kind === 'template' ? (
                      <TemplateCard
                        key={`t-${row.template.name}`}
                        template={row.template}
                        onDeleted={handleTemplateDeleted}
                      />
                    ) : (
                      <CivitaiTemplateCard
                        key={`c-${row.item.id}`}
                        item={row.item}
                        onStagedImport={(manifest) => handleImportOpen(manifest)}
                      />
                    ),
                  )}
                </div>
              ) : (
                <div className="text-center py-16">
                  <Layers className="w-10 h-10 text-slate-200 mx-auto mb-3" />
                  <p className="text-sm text-slate-500">
                    {sourceFilter === 'civitai'
                      ? searchQuery.trim()
                        ? `No CivitAI results for "${searchQuery}"`
                        : 'No CivitAI workflows found.'
                      : 'No workflows match your filters'}
                  </p>
                  {sourceFilter !== 'civitai' && (
                    <button
                      onClick={() => { setActiveCategory('All'); setSearchQuery(''); setActiveTags([]); setSourceFilter('all'); setReadyFilter('all'); }}
                      className="text-xs text-teal-600 hover:text-teal-700 mt-2"
                    >
                      Clear filters
                    </button>
                  )}
                </div>
              )}

              <div className="mt-4">
                {sourceFilter === 'civitai' ? (
                  <CivitaiLoadMore
                    hasMore={civHasMore}
                    loading={civLoading}
                    error={civError}
                    hasRows={civRows.length > 0}
                    onLoadMore={handleCivitaiLoadMore}
                  />
                ) : (
                  <Pagination
                    page={paged.page}
                    pageSize={paged.pageSize}
                    total={paged.total}
                    hasMore={paged.hasMore}
                    onPageChange={paged.setPage}
                    onPageSizeChange={paged.setPageSize}
                    className="rounded-lg border border-slate-200 bg-slate-50"
                  />
                )}
              </div>
            </main>
          </div>
        </div>
      </div>
      <ImportWorkflowModal
        open={importOpen}
        onClose={handleImportClose}
        initialManifest={importInitialManifest}
        onImported={handleImported}
      />
    </>
  );
}

// Re-exported so siblings (e.g. CivitaiTemplateCard) can hand a pre-staged
// manifest to the modal without lifting state up to App.
export type { StagedImportManifest };

interface CivitaiLoadMoreProps {
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  hasRows: boolean;
  onLoadMore: () => void;
}

/**
 * "Load more" footer for the CivitAI feed. We intentionally avoid numbered
 * pagination because CivitAI doesn't return a total row count.
 */
function CivitaiLoadMore({ hasMore, loading, error, hasRows, onLoadMore }: CivitaiLoadMoreProps) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 flex items-center justify-center gap-3">
      {loading ? (
        <span className="text-xs text-slate-500 inline-flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Loading…
        </span>
      ) : error && !hasRows ? (
        // Async feed errors are surfaced as toasts (see fetchCivitaiPage).
        // Keep a compact retry affordance here when the first page failed so
        // the user isn't stuck staring at an empty grid.
        <button type="button" onClick={onLoadMore} className="btn-secondary">
          Retry
        </button>
      ) : hasMore ? (
        <button type="button" onClick={onLoadMore} className="btn-secondary">
          Load more
        </button>
      ) : hasRows ? (
        <span className="text-xs text-slate-500">No more results</span>
      ) : null}
    </div>
  );
}
