// Local-catalog half of `ModelInfoModal`. Split out so the main modal file
// stays close to the per-file size cap and so the catalog rendering can be
// iterated on without touching the civitai branch.

import {
  ExternalLink, Star, HardDrive, AlertCircle, XCircle, Folder,
} from 'lucide-react';
import type { CatalogModel, UrlHost, UrlSource } from '../types';
import { formatBytes } from '../lib/utils';

// Allow-list of HTML tags we'll render for descriptions. Mirrors the list in
// the civitai branch since both ingest the same payload shape.
const ALLOWED_TAGS = new Set([
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'code', 'pre',
  'ul', 'ol', 'li', 'blockquote', 'a',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);

export function sanitizeHtml(raw: string): string {
  let s = raw.replace(/<(script|style|iframe)[^>]*>[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<\/?([a-z][a-z0-9]*)\b([^>]*)>/gi, (match, tag: string, attrs: string) => {
    const name = tag.toLowerCase();
    if (!ALLOWED_TAGS.has(name)) return '';
    const isClosing = match.startsWith('</');
    if (isClosing) return `</${name}>`;
    if (name === 'a') {
      const href = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
      const url = (href?.[1] ?? href?.[2] ?? href?.[3] ?? '').trim();
      if (/^(https?:)?\/\//i.test(url) || url.startsWith('#')) {
        const safe = url.replace(/"/g, '%22');
        return `<a href="${safe}" target="_blank" rel="noopener noreferrer">`;
      }
      return '<a>';
    }
    return `<${name}>`;
  });
  return s.trim();
}

export function hasHtmlTags(s: string): boolean {
  return /<[a-z][\s\S]*?>/i.test(s);
}

interface StatPillProps {
  icon: React.ElementType;
  label: string;
  value: string;
}

function StatPill({ icon: Icon, label, value }: StatPillProps): JSX.Element {
  return (
    <div className="inline-flex items-center gap-1.5 rounded-full bg-slate-50 px-2.5 py-1 text-[11px] ring-1 ring-inset ring-slate-200">
      <Icon className="w-3 h-3 text-slate-500" />
      <span className="text-slate-500">{label}</span>
      <span className="font-mono font-semibold text-slate-800">{value}</span>
    </div>
  );
}

const HOST_LABELS: Record<UrlHost, string> = {
  hf: 'HuggingFace',
  civitai: 'CivitAI',
  github: 'GitHub',
  generic: 'Generic',
};
const HOST_ORDER: UrlHost[] = ['hf', 'civitai', 'github', 'generic'];

/** Group `urlSources` by host while preserving the array's priority order
 * inside each group. Empty groups are not emitted. */
function groupUrlsByHost(sources: UrlSource[]): Record<UrlHost, UrlSource[]> {
  const out: Record<UrlHost, UrlSource[]> = { hf: [], civitai: [], github: [], generic: [] };
  for (const s of sources) {
    if (out[s.host]) out[s.host].push(s);
  }
  return out;
}

function SourcesSection(p: { sources: UrlSource[]; winnerUrl?: string }): JSX.Element {
  const grouped = groupUrlsByHost(p.sources);
  return (
    <section>
      <h3 className="field-label mb-1.5">Sources</h3>
      <div className="space-y-2">
        {HOST_ORDER.map((host) => {
          const entries = grouped[host];
          if (!entries || entries.length === 0) return null;
          return (
            <div key={host}>
              <div className="text-[11px] font-medium text-slate-600 mb-0.5">
                {HOST_LABELS[host]}
              </div>
              <ul className="space-y-1">
                {entries.map((s) => (
                  <li key={s.url} className="flex items-start gap-1.5 text-[11px]">
                    {s.url === p.winnerUrl && (
                      <Star
                        className="w-3 h-3 text-amber-500 mt-0.5 shrink-0"
                        aria-label="primary"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <a
                        href={s.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-teal-700 hover:text-teal-800 underline truncate inline-block max-w-full align-bottom"
                        title={s.url}
                      >
                        {s.url}
                      </a>
                      <div className="text-slate-400">declared by: {s.declaredBy}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function StatusSection(p: { gated?: boolean; gatedMessage?: string; error?: string }): JSX.Element {
  return (
    <section>
      <h3 className="field-label mb-1.5">Status</h3>
      <div className="space-y-1.5">
        {p.gated && (
          <div className="flex items-start gap-1.5">
            <span className="badge-pill badge-amber inline-flex items-center gap-1">
              <AlertCircle className="w-3 h-3" />
              Gated
            </span>
            {p.gatedMessage && (
              <span className="text-[11px] text-slate-600">{p.gatedMessage}</span>
            )}
          </div>
        )}
        {p.error && (
          <div className="flex items-start gap-1.5">
            <span className="badge-pill badge-rose inline-flex items-center gap-1">
              <XCircle className="w-3 h-3" />
              Error
            </span>
            <span className="text-[11px] text-slate-600 break-words">{p.error}</span>
          </div>
        )}
      </div>
    </section>
  );
}

/** Renders the body of the modal when the source is a local catalog row.
 * No header / footer — the caller wraps in `AppModal`. */
export function CatalogModelBody(p: { model: CatalogModel }): JSX.Element {
  const { model } = p;
  const description = model.description ?? '';
  const reference = model.reference;
  const fileFormat = (model.filename || model.name).split('.').pop()?.toLowerCase();
  const sizeBytes = model.fileSize || model.size_bytes;
  // Sources: prefer the modern `urlSources[]`; fall back to a single legacy
  // `url` for catalog rows that pre-date the migration. The fallback is
  // tagged `host: 'generic'` because we can't reliably derive the host
  // family from a freeform legacy URL without re-running the server's
  // detector — the row will be re-tagged on the next catalog upsert.
  const fallbackSource: UrlSource | null = (!model.urlSources || model.urlSources.length === 0)
      && model.url
    ? { url: model.url, host: 'generic', declaredBy: model.source || 'seed' }
    : null;
  const sources: UrlSource[] = model.urlSources && model.urlSources.length > 0
    ? model.urlSources
    : (fallbackSource ? [fallbackSource] : []);
  const winnerUrl = sources[0]?.url;

  return (
    <div className="space-y-4">
      <section>
        <div className="flex flex-wrap gap-1.5">
          {model.base && <span className="badge-pill badge-slate">{model.base}</span>}
          {fileFormat && <span className="badge-pill badge-slate">.{fileFormat}</span>}
          {model.installed
            ? <span className="badge-pill badge-emerald">Installed</span>
            : <span className="badge-pill badge-slate">Not installed</span>}
        </div>
      </section>

      <section>
        <h3 className="field-label mb-1.5">File</h3>
        <div className="flex flex-wrap gap-1.5">
          {sizeBytes ? <StatPill icon={HardDrive} label="size" value={formatBytes(sizeBytes)} /> : null}
          {model.save_path && (
            <StatPill icon={Folder} label="folder" value={`models/${model.save_path}/`} />
          )}
        </div>
        {/* Full path is only meaningful when installed — the "Folder" pill
            already covers the not-installed "where will it land" case. */}
        {model.installed && model.save_path && (
          <p className="mt-1 text-[11px] text-slate-500 font-mono break-all">
            models/{model.save_path}/{model.filename || model.name}
          </p>
        )}
      </section>

      {sources.length > 0 && <SourcesSection sources={sources} winnerUrl={winnerUrl} />}

      {(model.gated || model.error) && (
        <StatusSection
          gated={model.gated}
          gatedMessage={model.gated_message}
          error={model.error}
        />
      )}

      {description && (
        <section>
          <h3 className="field-label mb-1.5">Description</h3>
          {hasHtmlTags(description) ? (
            <div
              className="text-xs text-slate-700 break-words prose prose-sm max-w-none"
              dangerouslySetInnerHTML={{ __html: sanitizeHtml(description) }}
            />
          ) : (
            <p className="text-xs text-slate-700 whitespace-pre-wrap break-words">{description}</p>
          )}
        </section>
      )}

      {reference && (
        <a
          href={reference}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-teal-700 hover:text-teal-800 underline break-all"
        >
          <ExternalLink className="w-3 h-3 shrink-0" />
          {reference}
        </a>
      )}

      {!description && !reference && !model.base && sources.length === 0 && !model.gated && (
        <div className="empty-box">No details available.</div>
      )}
    </div>
  );
}
