// Top toolbar for the Ollama panel — search input (tab-aware), tab strip,
// and a context-sensitive Refresh button. Extracted from OllamaModelsPanel
// to keep the orchestrator under the 250-line cap.
//
// The search input is gated on the active tab: Library / HuggingFace each
// own a separately persisted query, Installed disables the input entirely
// (the list is short enough to scan without a filter).

import { RefreshCw, Search, X } from 'lucide-react';

export type OllamaPanelTab = 'installed' | 'library' | 'huggingface';

interface Props {
  tab: OllamaPanelTab;
  setTab: (t: OllamaPanelTab) => void;
  installedCount: number;
  libraryQuery: string;
  setLibraryQuery: (v: string) => void;
  hfQuery: string;
  setHfQuery: (v: string) => void;
  refreshing: boolean;
  onRefresh: () => void;
}

export function PanelToolbar({
  tab,
  setTab,
  installedCount,
  libraryQuery,
  setLibraryQuery,
  hfQuery,
  setHfQuery,
  refreshing,
  onRefresh,
}: Props) {
  return (
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
            {t === 'installed' && `Installed${installedCount ? ` (${installedCount})` : ''}`}
            {t === 'library' && 'Ollama Library'}
            {t === 'huggingface' && 'Hugging Face'}
          </button>
        ))}
        {/* Refresh sits inline with the tabs (last item) — context-aware:
            re-fetches the active tab's data. Tinted teal to read as an
            action rather than an "off" tab waiting to be picked. */}
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          aria-label="Refresh"
          className="tab-strip-item text-brand hover:text-brand/90 hover:bg-brand/10 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>
    </div>
  );
}
