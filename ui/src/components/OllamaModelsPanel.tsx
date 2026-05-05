// Ollama-source pane for the Models page. Replaces the now-removed
// `/chat/models` page; mounted by `pages/Models.tsx` when
// `source === 'ollama'`.
//
// Three sub-tabs (Installed, Ollama Library, HuggingFace) mirror the
// previous ChatModels layout. Library cards add a tag picker that
// lazy-fetches `/chat/models/library/<name>/tags` on each dropdown open
// (no client cache; the server has a 1h cache to absorb the cost), so
// the user can pull a specific quant/size like `llama3.2:70b-instruct-q4_K_M`
// instead of the default tag.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, Trash2, RefreshCw, Search, Check, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  api, type OllamaInstalledModel, type OllamaLibraryModel, type HfModelSummary,
  type OllamaTagEntry,
} from '../services/comfyui';
import { chatEvents } from '../services/chatEvents';
import { usePersistedState } from '../hooks/usePersistedState';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardFooter, CardHeader } from './ui/card';
import { Spinner } from './ui/spinner';
import Pagination from './layout/Pagination';
import ConfirmDialog from './modals/ConfirmDialog';
import {
  SelectField, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from './forms/SelectField';

type Tab = 'installed' | 'library' | 'huggingface';

interface PullState {
  taskId: string;
  percent: number;
  status: string;
  completed?: number;
  total?: number;
  digest?: string;
}

function formatBytes(n: number | undefined): string {
  if (!n || n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

/** Per-card tag picker. Lazy-fetches tags on each dropdown open — there's no
 *  client cache, but the server caches per-model for 1h so the cost is
 *  amortised. The picker disables the Pull button until tags arrive. */
function LibraryCardTagPicker({
  modelName,
  defaultTag,
  selectedTag,
  onSelect,
}: {
  modelName: string;
  defaultTag: string;
  selectedTag: string;
  onSelect: (tag: string) => void;
}) {
  const [tags, setTags] = useState<OllamaTagEntry[] | null>(null);
  const [loading, setLoading] = useState(false);

  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) return;
    setLoading(true);
    api.chat.getLibraryTags(modelName)
      .then(({ tags }) => setTags(tags))
      .catch(() => setTags([]))
      .finally(() => setLoading(false));
  }, [modelName]);

  const value = selectedTag || defaultTag;
  return (
    <SelectField value={value} onValueChange={onSelect} onOpenChange={handleOpenChange}>
      <SelectTrigger className="w-full">
        <SelectValue placeholder="Select tag…" />
      </SelectTrigger>
      <SelectContent>
        {loading && (
          <div className="flex items-center justify-center gap-2 py-2 text-xs text-muted-foreground">
            <Spinner size="sm" />
            Loading tags…
          </div>
        )}
        {!loading && tags === null && (
          // First open hasn't started yet — show the current selection only.
          <SelectItem value={value}>{value}</SelectItem>
        )}
        {!loading && tags && tags.length === 0 && (
          <div className="px-2 py-2 text-xs text-muted-foreground">No tags available.</div>
        )}
        {!loading && tags && tags.map(t => (
          <SelectItem key={t.tag} value={t.tag}>
            <span className="font-mono">{t.tag}</span>
            <span className="ml-2 text-[11px] text-muted-foreground">
              {[t.size, t.contextLength && `${t.contextLength} ctx`, t.input]
                .filter(Boolean).join(' · ')}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </SelectField>
  );
}

export default function OllamaModelsPanel() {
  // Persisted: active tab + last HF search query. Mirrors the Models +
  // Explore pages, which persist their own tab/source/search state via
  // `usePersistedState` so a reload restores where the user was.
  const [tab, setTab] = usePersistedState<Tab>('models.ollama.tab', 'installed');
  const [hfQuery, setHfQuery] = usePersistedState<string>('models.ollama.hfQuery', '');
  const [libraryQuery, setLibraryQuery] = usePersistedState<string>('models.ollama.libraryQuery', '');
  // Per-library-card tag selection — also persisted so a user's "I want the
  // 70b-instruct-q4 of llama3" choice survives a reload.
  const [librarySelectedTag, setLibrarySelectedTag] = usePersistedState<Record<string, string>>(
    'models.ollama.libraryTag',
    {},
  );

  const [installed, setInstalled] = useState<OllamaInstalledModel[]>([]);
  const [library, setLibrary] = useState<OllamaLibraryModel[]>([]);
  const [hf, setHf] = useState<HfModelSummary[]>([]);
  // Debounced mirror of `hfQuery` — matches the Models/Explore pattern so
  // search auto-fires 350ms after the last keystroke (no Search button).
  // Initialised to the persisted query so a reload restores results without
  // the 350ms debounce penalty.
  const [debouncedHfQuery, setDebouncedHfQuery] = useState(hfQuery);
  const [debouncedLibraryQuery, setDebouncedLibraryQuery] = useState(libraryQuery);
  const [hfBusy, setHfBusy] = useState(false);
  const [loadingTab, setLoadingTab] = useState(false);
  const [pulls, setPulls] = useState<Record<string, PullState>>({});
  // Server-side pagination for the library tab. `libraryPage` is 1-indexed;
  // `libraryTotal` is the row count returned by the server for the current
  // search filter. Page size is persisted (matches the `<Pagination>` UI's
  // size selector — the layout component drives it).
  const [libraryPage, setLibraryPage] = useState(1);
  const [libraryPageSize, setLibraryPageSize] = usePersistedState<number>(
    'models.ollama.libraryPageSize', 25,
  );
  const [libraryTotal, setLibraryTotal] = useState(0);

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

  // Read from the persisted `ollama_library` table. Cheap; no upstream call.
  // First call after a fresh DB cold-start will trigger a server-side seed
  // scrape transparently (~1s). The Refresh button uses `forceRefreshLibrary`
  // below to actually re-scrape.
  const fetchLibraryPage = useCallback((page: number, q: string, pageSize: number) => {
    setLoadingTab(true);
    api.chat.listLibrary({ q: q || undefined, page, pageSize })
      .then(({ items, total }) => {
        setLibrary(items);
        setLibraryTotal(total);
      })
      .catch((err) => {
        toast.error('Failed to load Ollama library', {
          description: err instanceof Error ? err.message : String(err),
        });
        setLibrary([]);
        setLibraryTotal(0);
      })
      .finally(() => setLoadingTab(false));
  }, []);

  // Force-rescrape upstream (POST /refresh) then re-list page 1. Triggered
  // from the Refresh button while the Library tab is active so the user
  // has an explicit way to pick up new models without waiting on a TTL.
  const forceRefreshLibrary = useCallback(() => {
    setLoadingTab(true);
    api.chat.refreshLibrary()
      .then(() => {
        setLibraryPage(1);
        return api.chat.listLibrary({
          q: debouncedLibraryQuery || undefined,
          page: 1,
          pageSize: libraryPageSize,
        });
      })
      .then(({ items, total }) => {
        setLibrary(items);
        setLibraryTotal(total);
      })
      .catch((err) => {
        toast.error('Failed to refresh Ollama library', {
          description: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => setLoadingTab(false));
  }, [debouncedLibraryQuery, libraryPageSize]);

  // Library cards need to know which models are already installed (the
  // "Installed" badge + pull-button gate) — load the installed list once on
  // mount so the Library tab reflects state even if the user lands there
  // before ever visiting the Installed tab.
  useEffect(() => { refreshInstalled(); }, [refreshInstalled]);

  useEffect(() => {
    if (tab === 'library') fetchLibraryPage(libraryPage, debouncedLibraryQuery, libraryPageSize);
  }, [tab, fetchLibraryPage, libraryPage, debouncedLibraryQuery, libraryPageSize]);

  useEffect(() => {
    const offProgress = chatEvents.onPullProgress((p) => {
      setPulls(prev => ({
        ...prev,
        [p.name]: {
          taskId: p.taskId,
          percent: p.percent,
          status: p.status ?? '',
          completed: p.completed,
          total: p.total,
          digest: p.digest,
        },
      }));
    });
    const offDone = chatEvents.onPullDone(({ name }) => {
      setPulls(prev => { const { [name]: _r, ...rest } = prev; return rest; });
      toast.success(`Pulled ${name}`);
      refreshInstalled();
    });
    const offError = chatEvents.onPullError(({ name, error }) => {
      setPulls(prev => { const { [name]: _r, ...rest } = prev; return rest; });
      toast.error(`Pull failed: ${name}`, { description: error });
    });
    return () => { offProgress(); offDone(); offError(); };
  }, [refreshInstalled]);

  const handlePull = async (name: string) => {
    try {
      await api.chat.pullModel(name);
      setPulls(prev => ({
        ...prev,
        [name]: { taskId: '', percent: 0, status: 'starting' },
      }));
    } catch (err) {
      toast.error('Failed to start pull', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // Delete confirm — opened from the per-row Trash button on the
  // installed-models tab. Caller passes the model name to ack; the
  // ConfirmDialog runs the actual deletion via `runDelete` below.
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

  // Same debounce for the library search box. Resetting `libraryPage` to 1
  // ensures we don't end up viewing page 5 of a result set that only has 2
  // pages after the user typed a narrower query.
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedLibraryQuery(libraryQuery);
      setLibraryPage(1);
    }, 350);
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

  // Tag-aware installed check. The user picks a variant from the per-card
  // dropdown (`selectedTag`); we count the model as installed only when
  // that exact `name:tag` pair is present locally — switching the dropdown
  // to a tag we don't have flips the badge back to "Pull".
  // Ollama's `/api/tags` typically returns names with `:latest` appended
  // even for the bare-name pull, so the `latest` branch also accepts the
  // un-suffixed form as a safety net.
  // We also expose a coarse "any-tag-installed" predicate so the card body
  // can show "vN already installed" copy when the user is viewing a
  // different tag of the same model — telegraphing that something IS on
  // disk even though the current dropdown picks something else.
  const isExactInstalled = useMemo(() => {
    return (modelName: string, tag: string) => {
      const ref = `${modelName}:${tag}`;
      return installed.some((i) =>
        i.name === ref ||
        (tag === 'latest' && (i.name === modelName || i.name === `${modelName}:latest`)),
      );
    };
  }, [installed]);
  const isAnyTagInstalled = useMemo(() => {
    return (modelName: string) => installed.some((i) =>
      i.name === modelName || i.name.startsWith(`${modelName}:`),
    );
  }, [installed]);

  return (
    <div className="space-y-3">
      {/* Toolbar — search bar always present (left, flex-1) so the layout
          stays stable across tabs. Active for Library + Hugging Face;
          disabled on Installed (the installed list is short enough to scan
          without filtering, and the page already has tab-level navigation).
          Each tab has its own persisted query so switching tabs doesn't
          surprise the user with a stale filter from the other side. */}
      <div className="flex flex-col md:flex-row md:items-center gap-2">
        <div
          className={`flex-1 field-wrap ${tab === 'installed' ? 'opacity-50 cursor-not-allowed' : ''}`}
          aria-disabled={tab === 'installed'}
        >
          <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          <input
            type="text"
            value={tab === 'library' ? libraryQuery : hfQuery}
            onChange={(e) => {
              if (tab === 'library') setLibraryQuery(e.target.value);
              else if (tab === 'huggingface') setHfQuery(e.target.value);
            }}
            placeholder={
              tab === 'library' ? 'Search the Ollama library…'
                : tab === 'huggingface' ? 'Search HuggingFace GGUF models…'
                  : 'Search not available on Installed tab'
            }
            disabled={tab === 'installed'}
            className="field-input disabled:cursor-not-allowed"
          />
          {tab === 'library' && libraryQuery !== '' && (
            <button
              type="button"
              onClick={() => setLibraryQuery('')}
              aria-label="Clear search"
              className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          {tab === 'huggingface' && hfQuery !== '' && (
            <button
              type="button"
              onClick={() => setHfQuery('')}
              aria-label="Clear search"
              className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <div
          role="tablist"
          aria-label="Ollama source"
          className="tab-strip self-start md:self-auto"
        >
          {(['installed', 'library', 'huggingface'] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`tab-strip-item ${tab === t ? 'is-active' : ''}`}
            >
              {t === 'installed' && `Installed${installed.length ? ` (${installed.length})` : ''}`}
              {t === 'library' && 'Ollama Library'}
              {t === 'huggingface' && 'Hugging Face'}
            </button>
          ))}
          {/* Refresh sits inline with the tabs (last item) — context-aware:
              re-fetches the active tab's data. Tinted teal to read as an
              action rather than an "off" tab waiting to be picked. */}
          <button
            type="button"
            onClick={tab === 'installed' ? refreshInstalled : tab === 'library' ? forceRefreshLibrary : handleHfRefresh}
            disabled={loadingTab || hfBusy}
            aria-label="Refresh"
            className="tab-strip-item text-brand hover:text-brand/90 hover:bg-brand/10 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loadingTab || hfBusy ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {tab === 'installed' && (
        <div className="grid gap-2 md:grid-cols-2">
          {loadingTab && <div className="col-span-full py-8 text-center"><Spinner size="lg" className="mx-auto text-muted-foreground" /></div>}
          {!loadingTab && installed.length === 0 && (
            <div className="col-span-full py-8 text-center text-sm text-muted-foreground">
              No models installed. Browse the Ollama Library tab to pull one.
            </div>
          )}
          {installed.map(m => (
            <Card key={m.name}>
              <CardHeader className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-foreground font-mono">{m.name}</h3>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {formatBytes(m.size)}{m.modified_at ? ` · modified ${new Date(m.modified_at).toLocaleDateString()}` : ''}
                  </p>
                </div>
                <Button
                  onClick={() => setDeleteTarget(m.name)}
                  variant="secondary"
                  className="!text-destructive hover:!bg-destructive/10"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Delete
                </Button>
              </CardHeader>
            </Card>
          ))}
        </div>
      )}

      {tab === 'library' && (
        <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
          {loadingTab && <div className="col-span-full py-8 text-center"><Spinner size="lg" className="mx-auto text-muted-foreground" /></div>}
          {!loadingTab && library.length === 0 && (
            <div className="col-span-full py-8 text-center text-sm text-muted-foreground">
              {debouncedLibraryQuery
                ? `No models match "${debouncedLibraryQuery}".`
                : "Couldn't load the Ollama library (the upstream may be unreachable)."}
            </div>
          )}
          {library.map(m => {
            const selectedTag = librarySelectedTag[m.name] ?? 'latest';
            const pullRef = `${m.name}:${selectedTag}`;
            const pull = pulls[pullRef] ?? pulls[m.name];
            // `isInstalled` controls the primary CTA — gate by exact ref so
            // switching the tag dropdown to a variant the user doesn't have
            // re-enables the Pull button. `hasOtherTagInstalled` drives the
            // secondary "another variant of this model is already on disk"
            // hint so the user isn't surprised that a model they "have"
            // looks pull-able after they pick a different size.
            const isInstalled = isExactInstalled(m.name, selectedTag);
            const hasOtherTagInstalled = !isInstalled && isAnyTagInstalled(m.name);
            return (
              <Card key={m.name}>
                <CardHeader className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-foreground font-mono">{m.name}</h3>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {m.pulls} pulls · {m.tagCount} tags · {m.updated}
                    </p>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2">
                  {m.description && <p className="text-xs text-foreground">{m.description}</p>}
                  {m.sizes.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {m.sizes.map(s => (
                        <Badge key={s} variant="slate">{s}</Badge>
                      ))}
                    </div>
                  )}
                  {m.capabilities.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {m.capabilities.map(c => (
                        <Badge key={c} variant="teal">{c}</Badge>
                      ))}
                    </div>
                  )}
                  <div>
                    <label className="field-label mb-1 block">Tag / variant</label>
                    <LibraryCardTagPicker
                      modelName={m.name}
                      defaultTag="latest"
                      selectedTag={selectedTag}
                      onSelect={(tag) => setLibrarySelectedTag(prev => ({ ...prev, [m.name]: tag }))}
                    />
                  </div>
                  {pull && (
                    <div className="space-y-1">
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span className="truncate">
                          {pull.status || 'pulling'}
                          {pull.digest ? ` · ${pull.digest.slice(0, 12)}` : ''}
                        </span>
                        <span>{pull.percent}%</span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                        <div className="h-full bg-brand transition-all" style={{ width: `${pull.percent}%` }} />
                      </div>
                      {pull.total ? (
                        <div className="text-[10px] text-muted-foreground">
                          {formatBytes(pull.completed ?? 0)} / {formatBytes(pull.total)}
                        </div>
                      ) : null}
                    </div>
                  )}
                </CardContent>
                <CardFooter>
                  <p className="text-xs text-muted-foreground">
                    {isInstalled
                      ? 'Already installed'
                      : hasOtherTagInstalled
                        ? `Another tag is installed · Pulls ${pullRef}`
                        : `Pulls ${pullRef}`}
                  </p>
                  {isInstalled && !pull ? (
                    <Badge variant="emerald">
                      <Check className="w-3 h-3" />
                      Installed
                    </Badge>
                  ) : (
                    <Button
                      onClick={() => handlePull(pullRef)}
                      disabled={!!pull}
                      size="sm"
                    >
                      <Download className="w-3.5 h-3.5" />
                      {pull ? 'Pulling…' : 'Pull'}
                    </Button>
                  )}
                </CardFooter>
              </Card>
            );
          })}
        </div>
      )}

      {/* Library pager — server-side pagination via `?page=&pageSize=`.
          Re-uses the shared `<Pagination>` chrome (border-t / slate-50 /
          rows-per-page selector) so the look matches Models / Downloads. */}
      {tab === 'library' && (
        <Pagination
          page={libraryPage}
          pageSize={libraryPageSize}
          total={libraryTotal}
          hasMore={libraryPage * libraryPageSize < libraryTotal}
          onPageChange={setLibraryPage}
          onPageSizeChange={(size) => { setLibraryPageSize(size); setLibraryPage(1); }}
        />
      )}

      {tab === 'huggingface' && (
        <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
          {hf.length === 0 && !hfBusy && (
            <div className="col-span-full py-8 text-center text-sm text-muted-foreground">
              {hfQuery.trim() ? 'No results.' : 'Type a query to search HuggingFace.'}
            </div>
          )}
          {hfBusy && hf.length === 0 && (
            <div className="col-span-full py-8 text-center"><Spinner size="lg" className="mx-auto text-muted-foreground" /></div>
          )}
            {hf.map(m => (
              <Card key={m.id}>
                <CardHeader className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-foreground font-mono truncate">{m.id}</h3>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {m.downloads != null && `${m.downloads.toLocaleString()} downloads`}
                      {m.likes != null && ` · ${m.likes} likes`}
                    </p>
                  </div>
                </CardHeader>
                <CardContent>
                  {m.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {m.tags.slice(0, 6).map(t => (
                        <Badge key={t} variant="slate">{t}</Badge>
                      ))}
                    </div>
                  )}
                  <p className="mt-2 text-xs text-muted-foreground">
                    Pull GGUF models into Ollama via:
                    <code className="block mt-1 rounded bg-muted px-2 py-1 font-mono">
                      ollama pull hf.co/{m.id}
                    </code>
                  </p>
                </CardContent>
                <CardFooter>
                  <p className="text-xs text-muted-foreground">Tag is auto-selected by Ollama</p>
                  <Button
                    onClick={() => handlePull(`hf.co/${m.id}`)}
                    size="sm"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Pull
                  </Button>
                </CardFooter>
              </Card>
            ))}
        </div>
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
