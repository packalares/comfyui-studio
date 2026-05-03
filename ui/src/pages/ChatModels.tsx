import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, Trash2, RefreshCw, Search, ArrowLeft, Check } from 'lucide-react';
import { toast } from 'sonner';
import PageSubbar from '../components/layout/PageSubbar';
import { Spinner } from '../components/ui/spinner';
import {
  api, type OllamaInstalledModel, type OllamaLibraryModel, type HfModelSummary,
} from '../services/comfyui';
import { chatEvents } from '../services/chatEvents';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardFooter, CardHeader } from '../components/ui/card';

type Tab = 'installed' | 'library' | 'huggingface';

interface PullState {
  taskId: string;
  percent: number;
  status: string;
  // Bytes for the current layer (Ollama emits one progress object per layer
  // it's downloading). Surfaced under the bar so the user can see throughput.
  completed?: number;
  total?: number;
  // Short digest prefix of the layer being pulled, used as a stand-in for
  // "layer N/M" since Ollama doesn't expose a total layer count.
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

export default function ChatModels() {
  const [tab, setTab] = useState<Tab>('installed');
  const [installed, setInstalled] = useState<OllamaInstalledModel[]>([]);
  const [library, setLibrary] = useState<OllamaLibraryModel[]>([]);
  const [hf, setHf] = useState<HfModelSummary[]>([]);
  const [hfQuery, setHfQuery] = useState('');
  const [hfBusy, setHfBusy] = useState(false);
  const [loadingTab, setLoadingTab] = useState(false);
  const [pulls, setPulls] = useState<Record<string, PullState>>({});

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

  const refreshLibrary = useCallback(() => {
    setLoadingTab(true);
    api.chat.listLibrary()
      .then(({ items }) => setLibrary(items))
      .catch((err) => {
        toast.error('Failed to load Ollama library', {
          description: err instanceof Error ? err.message : String(err),
        });
        setLibrary([]);
      })
      .finally(() => setLoadingTab(false));
  }, []);

  useEffect(() => {
    if (tab === 'installed') refreshInstalled();
    else if (tab === 'library') refreshLibrary();
  }, [tab, refreshInstalled, refreshLibrary]);

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

  const handleDelete = async (name: string) => {
    if (!confirm(`Delete ${name}?`)) return;
    try {
      await api.chat.deleteModel(name);
      toast.success(`Deleted ${name}`);
      refreshInstalled();
    } catch (err) {
      toast.error('Failed to delete', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleHfSearch = async () => {
    const q = hfQuery.trim();
    if (!q) return;
    setHfBusy(true);
    try {
      const { items } = await api.chat.searchHf(q);
      setHf(items);
    } catch (err) {
      toast.error('HF search failed', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setHfBusy(false);
    }
  };

  return (
    <>
      <PageSubbar
        title="Chat Models"
        description="Browse, pull, and manage local Ollama models"
        right={
          <Button asChild variant="secondary" size="sm" aria-label="Back to chat">
            <Link to="/chat">
              <ArrowLeft className="w-3.5 h-3.5" />
              Back to chat
            </Link>
          </Button>
        }
      />
      <div className="page-container space-y-3">
        <div className="flex items-center gap-2">
          <div role="tablist" aria-label="Chat model source" className="tab-strip">
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
          </div>
          <div className="ml-auto">
            <Button
              onClick={tab === 'installed' ? refreshInstalled : tab === 'library' ? refreshLibrary : handleHfSearch}
              disabled={loadingTab}
              variant="secondary"
              size="sm"
              aria-label="Refresh"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loadingTab ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </div>

        {tab === 'installed' && (
          <div className="grid gap-2 md:grid-cols-2">
            {loadingTab && <div className="col-span-full py-8 text-center"><Spinner size="lg" className="mx-auto text-slate-400" /></div>}
            {!loadingTab && installed.length === 0 && (
              <div className="col-span-full py-8 text-center text-sm text-slate-400">
                No models installed. Browse the Ollama Library tab to pull one.
              </div>
            )}
            {installed.map(m => (
              <Card key={m.name}>
                <CardHeader className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900 font-mono">{m.name}</h3>
                    <p className="mt-0.5 text-[11px] text-slate-400">
                      {formatBytes(m.size)}{m.modified_at ? ` . modified ${new Date(m.modified_at).toLocaleDateString()}` : ''}
                    </p>
                  </div>
                  <Button
                    onClick={() => handleDelete(m.name)}
                    variant="secondary"
                    className="!text-red-600 hover:!bg-red-50"
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
            {loadingTab && <div className="col-span-full py-8 text-center"><Spinner size="lg" className="mx-auto text-slate-400" /></div>}
            {!loadingTab && library.length === 0 && (
              <div className="col-span-full py-8 text-center text-sm text-slate-400">
                Couldn't load the Ollama library (the upstream may be unreachable).
              </div>
            )}
            {library.map(m => {
              const pull = pulls[m.name];
              // "Installed" shortcut is name-prefix match because Ollama tags
              // (`llama3:8b`) install under their full reference but the
              // library catalogue lists the base name. Either form counts.
              const isInstalled = installed.some(i =>
                i.name === m.name || i.name.startsWith(`${m.name}:`),
              );
              return (
                <Card key={m.name}>
                  <CardHeader className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold text-slate-900 font-mono">{m.name}</h3>
                      <p className="mt-0.5 text-[11px] text-slate-400">
                        {m.pulls} pulls . {m.tagCount} tags . {m.updated}
                      </p>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {m.description && <p className="text-xs text-slate-600">{m.description}</p>}
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
                    {pull && (
                      <div className="space-y-1">
                        <div className="flex justify-between text-xs text-slate-500">
                          <span className="truncate">
                            {pull.status || 'pulling'}
                            {pull.digest ? ` - ${pull.digest.slice(0, 12)}` : ''}
                          </span>
                          <span>{pull.percent}%</span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                          <div className="h-full bg-blue-500 transition-all" style={{ width: `${pull.percent}%` }} />
                        </div>
                        {pull.total ? (
                          <div className="text-[10px] text-slate-400">
                            {formatBytes(pull.completed ?? 0)} / {formatBytes(pull.total)}
                          </div>
                        ) : null}
                      </div>
                    )}
                  </CardContent>
                  <CardFooter>
                    <p className="text-xs text-slate-500">
                      {isInstalled
                        ? 'Already installed'
                        : m.sizes.length > 0
                          ? `Pulls latest tag (${m.sizes[0]} default)`
                          : 'Pulls the default tag'}
                    </p>
                    {isInstalled && !pull ? (
                      <Badge variant="emerald">
                        <Check className="w-3 h-3" />
                        Installed
                      </Badge>
                    ) : (
                      <Button
                        onClick={() => handlePull(m.name)}
                        disabled={!!pull}
                        size="sm"
                      >
                        <Download className="w-3.5 h-3.5" />
                        {pull ? 'Pulling...' : 'Pull'}
                      </Button>
                    )}
                  </CardFooter>
                </Card>
              );
            })}
          </div>
        )}

        {tab === 'huggingface' && (
          <div className="space-y-3">
            <div className="flex gap-2">
              <input
                type="text"
                value={hfQuery}
                onChange={(e) => setHfQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleHfSearch(); }}
                placeholder="Search HuggingFace GGUF models..."
                className="field-input flex-1"
              />
              <Button onClick={handleHfSearch} disabled={hfBusy || !hfQuery.trim()}>
                <Search className="w-4 h-4" />
                Search
              </Button>
            </div>
            <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
              {hf.length === 0 && !hfBusy && (
                <div className="col-span-full py-8 text-center text-sm text-slate-400">
                  Enter a query above to search.
                </div>
              )}
              {hf.map(m => (
                <Card key={m.id}>
                  <CardHeader className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-slate-900 font-mono truncate">{m.id}</h3>
                      <p className="mt-0.5 text-[11px] text-slate-400">
                        {m.downloads != null && `${m.downloads.toLocaleString()} downloads`}
                        {m.likes != null && ` . ${m.likes} likes`}
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
                    <p className="mt-2 text-xs text-slate-500">
                      Pull GGUF models into Ollama via the CLI:
                      <code className="block mt-1 rounded bg-slate-100 px-2 py-1 font-mono">
                        ollama pull hf.co/{m.id}
                      </code>
                    </p>
                  </CardContent>
                  <CardFooter>
                    <p className="text-xs text-slate-500">Tag is auto-selected by Ollama</p>
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
          </div>
        )}
      </div>
    </>
  );
}
