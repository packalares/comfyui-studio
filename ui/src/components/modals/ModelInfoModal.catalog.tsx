// Local-catalog half of `ModelInfoModal`. Split out so the main modal file
// stays close to the per-file size cap and so the catalog rendering can be
// iterated on without touching the civitai branch.

import { useEffect, useState } from 'react';
import {
  ExternalLink, HardDrive, AlertCircle, XCircle, Folder, Copy, Check,
  CheckCircle2, HelpCircle, Globe, Github, Sparkles, Heart, FileCog,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import type { CatalogModel, UrlHost, UrlSource, CatalogEnrichment } from '../../types';
import { formatBytes } from '../../lib/utils';
import { Badge } from '../ui/badge';
import { api, modelPreviewUrl } from '../../services/comfyui';

// Allow-list of HTML tags we'll render for descriptions. Mirrors the list in
// the civitai branch since both ingest the same payload shape.
const ALLOWED_TAGS = new Set([
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'code', 'pre',
  'ul', 'ol', 'li', 'blockquote', 'a',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);

export function sanitizeHtml(raw: string): string {
  // Loop the script/style/iframe strip until stable so a reforming construct
  // (e.g. `<scr<script>ipt>`) can't survive a single pass.
  let s = raw;
  let prev: string;
  do { prev = s; s = s.replace(/<(script|style|iframe)[^>]*>[\s\S]*?<\/\1>/gi, ''); } while (s !== prev);
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

// ---- Constants ----

const NSFW_LABELS: Record<number, string> = { 0: 'SFW', 1: 'PG13', 2: 'R', 3: 'X', 4: 'XXX' };

const HOST_LABELS: Record<UrlHost, string> = {
  hf: 'HuggingFace',
  civitai: 'CivitAI',
  github: 'GitHub',
  generic: 'Direct',
};
const HOST_ORDER: UrlHost[] = ['civitai', 'hf', 'github', 'generic'];
const HOST_ICONS: Record<UrlHost, React.ElementType> = {
  hf: Heart,
  civitai: Sparkles,
  github: Github,
  generic: Globe,
};

type VerifiedEntry = NonNullable<CatalogEnrichment>['urlSources_verified'] extends Array<infer T> | undefined
  ? T
  : never;

// ---- Tiny shared building blocks ----

/** Consistent uppercase mini-header used above every section. */
function FieldLabel({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
      {children}
    </h3>
  );
}

function VerifyBadge({ verdict }: { verdict: VerifiedEntry | undefined }): JSX.Element | null {
  if (!verdict) return null;
  const base = 'w-3.5 h-3.5 shrink-0';
  if (verdict.status === 'ok') {
    return <CheckCircle2 className={`${base} text-success`} aria-label="Hash verified — matches upstream" />;
  }
  if (verdict.status === 'mismatch') {
    return <XCircle className={`${base} text-destructive`} aria-label="Hash mismatch — differs from upstream" />;
  }
  return (
    <HelpCircle
      className={`${base} text-muted-foreground/60`}
      aria-label={verdict.error ? `Verification error: ${verdict.error}` : 'Could not verify hash'}
    />
  );
}

/** Group `urlSources` by host while preserving array priority order. */
function groupUrlsByHost(sources: UrlSource[]): Record<UrlHost, UrlSource[]> {
  const out: Record<UrlHost, UrlSource[]> = { hf: [], civitai: [], github: [], generic: [] };
  for (const s of sources) {
    if (out[s.host]) out[s.host].push(s);
  }
  return out;
}

// ---- Sources card: grouped by host with verify pills + primary tag ----

function SourcesSection(p: {
  sources: UrlSource[];
  winnerUrl?: string;
  verified?: VerifiedEntry[];
}): JSX.Element {
  const grouped = groupUrlsByHost(p.sources);
  return (
    <section>
      <FieldLabel>Download sources</FieldLabel>
      <div className="rounded-lg border border-border bg-muted/20 overflow-hidden">
        {HOST_ORDER.map((host, gIdx) => {
          const entries = grouped[host];
          if (!entries || entries.length === 0) return null;
          const HostIcon = HOST_ICONS[host];
          return (
            <div
              key={host}
              className={`px-3 py-2.5 ${gIdx > 0 ? 'border-t border-border/60' : ''}`}
            >
              <div className="flex items-center gap-1.5 mb-2">
                <HostIcon className="w-3.5 h-3.5 text-muted-foreground" />
                <span className="text-[11px] font-semibold text-foreground">
                  {HOST_LABELS[host]}
                </span>
                {entries.length > 1 && (
                  <span className="text-[10px] text-muted-foreground/70">({entries.length})</span>
                )}
              </div>
              <ul className="space-y-1">
                {entries.map((s) => {
                  const verdict = p.verified?.find((v) => v.url === s.url);
                  const isPrimary = s.url === p.winnerUrl;
                  return (
                    <li
                      key={s.url}
                      className="flex items-center gap-2 text-[11px] rounded px-1.5 py-1 hover:bg-muted/50 transition-colors"
                    >
                      <VerifyBadge verdict={verdict} />
                      <a
                        href={s.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-brand hover:text-brand/80 truncate flex-1 min-w-0"
                        title={s.url}
                      >
                        {s.url.replace(/^https?:\/\//, '')}
                      </a>
                      <ExternalLink className="w-3 h-3 text-muted-foreground/60 shrink-0" />
                      {isPrimary && (
                        <span className="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-warning/15 text-warning shrink-0">
                          Primary
                        </span>
                      )}
                      <span
                        className="text-[10px] text-muted-foreground/70 shrink-0 font-mono max-w-[120px] truncate"
                        title={s.declaredBy}
                      >
                        {s.declaredBy}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ---- Status: left-border accented warning/error panel ----

function StatusSection(p: { gated?: boolean; gatedMessage?: string; error?: string }): JSX.Element {
  const accent = p.error ? 'border-destructive bg-destructive/5' : 'border-warning bg-warning/5';
  return (
    <section className={`rounded-r-lg border-l-4 ${accent} px-3 py-2.5 space-y-2`}>
      {p.gated && (
        <div className="flex items-start gap-2 text-xs">
          <AlertCircle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
          <div className="min-w-0">
            <div className="font-semibold text-warning">Gated download</div>
            {p.gatedMessage && (
              <div className="text-foreground/80 mt-0.5 break-words">{p.gatedMessage}</div>
            )}
          </div>
        </div>
      )}
      {p.error && (
        <div className="flex items-start gap-2 text-xs">
          <XCircle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
          <div className="min-w-0">
            <div className="font-semibold text-destructive">Error</div>
            <div className="text-foreground/80 mt-0.5 break-words">{p.error}</div>
          </div>
        </div>
      )}
    </section>
  );
}

// ---- Trigger word pill: prominent, hover-to-copy ----

function TriggerWordPill({ word }: { word: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(word).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => { /* ignore clipboard errors */ });
  };
  return (
    <button
      type="button"
      onClick={copy}
      title="Click to copy"
      className="group inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs bg-muted hover:bg-brand/10 border border-border hover:border-brand/40 text-foreground hover:text-brand font-mono transition-all"
    >
      <span>{word}</span>
      {copied
        ? <Check className="w-3 h-3 text-success shrink-0" />
        : <Copy className="w-3 h-3 text-muted-foreground/50 group-hover:text-brand shrink-0" />}
    </button>
  );
}

// ---- Used by N templates ----
//
// Lazy-fetches the model→templates reverse index on mount. Renders inline
// chips that link to the Explore page filtered to that template, so the
// user can jump straight to what's using a model.

function UsedByTemplates({ filename }: { filename: string }): JSX.Element | null {
  const [templates, setTemplates] = useState<string[] | null>(null);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.getModelUsedBy(filename)
      .then((list) => { if (!cancelled) setTemplates(list); })
      .catch(() => { if (!cancelled) setErrored(true); });
    return () => { cancelled = true; };
  }, [filename]);

  // Hide section entirely while loading or on error or when empty — no point
  // showing an empty "Used by" frame.
  if (errored) return null;
  if (templates === null || templates.length === 0) return null;

  return (
    <section>
      <FieldLabel>Used by {templates.length} template{templates.length === 1 ? '' : 's'}</FieldLabel>
      <div className="flex flex-wrap gap-1.5">
        {templates.map((name) => (
          <Link
            key={name}
            to={`/studio/${encodeURIComponent(name)}`}
            className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] bg-muted hover:bg-brand/10 border border-border hover:border-brand/40 text-foreground hover:text-brand font-mono transition-all"
            title={`Open ${name} in Studio`}
          >
            <FileCog className="w-3 h-3 text-muted-foreground" />
            {name}
          </Link>
        ))}
      </div>
    </section>
  );
}

// ---- Main body ----

/** Renders the body of the modal when the source is a local catalog row.
 * No header / footer — the caller wraps in `AppModal`. Enrich + Favorite
 * actions live in `CatalogModalShell`'s subtitle slot. */
export function CatalogModelBody(p: { model: CatalogModel }): JSX.Element {
  const { model } = p;

  // Prefer the enrichment description (CivitAI HTML) over the catalog row's
  // own `description` (which for scan-discovered rows is the boilerplate
  // "Locally discovered model, not in official list").
  const description = model.enrichment?.description?.trim()
    || model.description
    || '';
  const reference = model.reference;
  const previewSrc = model.enrichment?.preview_local_path
    ? modelPreviewUrl(model.save_path, model.filename, 512)
    : null;
  const fileFormat = (model.filename || model.name).split('.').pop()?.toLowerCase();
  const sizeBytes = model.fileSize || model.size_bytes;
  // Sources: prefer the modern `urlSources[]`; fall back to a single legacy
  // `url` for catalog rows that pre-date the migration.
  const fallbackSource: UrlSource | null = (!model.urlSources || model.urlSources.length === 0)
      && model.url
    ? { url: model.url, host: 'generic', declaredBy: model.source || 'seed' }
    : null;
  const sources: UrlSource[] = model.urlSources && model.urlSources.length > 0
    ? model.urlSources
    : (fallbackSource ? [fallbackSource] : []);
  const winnerUrl = sources[0]?.url;

  const enrichment = model.enrichment;
  const baseModel = model.base || enrichment?.base_model;
  const tags = enrichment?.tags ?? [];
  const triggers = enrichment?.trigger_words ?? [];
  const nsfw = typeof enrichment?.nsfw_level === 'number' && enrichment.nsfw_level > 0;

  return (
    <div className="space-y-5">
      {/* HERO — preview image left, key metadata stack right */}
      <section className="flex flex-col sm:flex-row gap-5">
        {previewSrc && (
          <div className="sm:w-[45%] shrink-0">
            <div className="rounded-xl overflow-hidden ring-1 ring-border bg-muted shadow-sm">
              <img
                src={previewSrc}
                alt={model.filename}
                loading="lazy"
                decoding="async"
                className="w-full max-h-80 object-contain"
              />
            </div>
          </div>
        )}

        <div className="flex-1 min-w-0 space-y-4">
          {/* Chip cluster — color encodes meaning */}
          <div className="flex flex-wrap gap-1.5 items-center">
            {baseModel && <Badge variant="brand">{baseModel}</Badge>}
            {fileFormat && <Badge variant="neutral">.{fileFormat}</Badge>}
            {model.installed
              ? <Badge variant="success">Installed</Badge>
              : <Badge variant="neutral">Not installed</Badge>}
            {nsfw && (
              <Badge variant="danger">
                {NSFW_LABELS[enrichment!.nsfw_level!] ?? `NSFW:${enrichment!.nsfw_level}`}
              </Badge>
            )}
          </div>

          {/* Trigger words — prominent, copy-on-click */}
          {triggers.length > 0 && (
            <div>
              <FieldLabel>Trigger words</FieldLabel>
              <div className="flex flex-wrap gap-1.5">
                {triggers.map((w) => <TriggerWordPill key={w} word={w} />)}
              </div>
            </div>
          )}

          {/* File info card — key/value rows + full path */}
          <div>
            <FieldLabel>File</FieldLabel>
            <div className="rounded-lg border border-border bg-muted/20 px-3 py-2.5 space-y-1.5">
              {sizeBytes ? (
                <div className="flex items-center gap-2 text-xs">
                  <HardDrive className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                  <span className="text-muted-foreground">Size</span>
                  <span className="font-mono font-semibold text-foreground ml-auto">
                    {formatBytes(sizeBytes)}
                  </span>
                </div>
              ) : null}
              {model.save_path && (
                <div className="flex items-center gap-2 text-xs">
                  <Folder className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                  <span className="text-muted-foreground">Folder</span>
                  <span
                    className="font-mono text-foreground/80 ml-auto truncate"
                    title={`models/${model.save_path}/`}
                  >
                    models/{model.save_path}/
                  </span>
                </div>
              )}
              {model.installed && model.save_path && (
                <div className="pt-1.5 border-t border-border/60">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">
                    Full path
                  </div>
                  <div className="font-mono text-[11px] text-foreground break-all">
                    models/{model.save_path}/{model.filename || model.name}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Tags — full width cloud below hero */}
      {tags.length > 0 && (
        <section>
          <FieldLabel>Tags</FieldLabel>
          <div className="flex flex-wrap gap-1.5">
            {tags.map((t) => (
              <Badge key={t} variant="neutral">{t}</Badge>
            ))}
          </div>
        </section>
      )}

      {/* Used by — reverse-lookup templates that reference this filename */}
      <UsedByTemplates filename={model.filename || model.name} />

      {/* Download sources */}
      {sources.length > 0 && (
        <SourcesSection
          sources={sources}
          winnerUrl={winnerUrl}
          verified={enrichment?.urlSources_verified}
        />
      )}

      {/* Status — only when gated or errored */}
      {(model.gated || model.error) && (
        <StatusSection
          gated={model.gated}
          gatedMessage={model.gated_message}
          error={model.error}
        />
      )}

      {/* Description — divider + proper prose */}
      {description && (
        <section className="border-t border-border pt-4">
          <FieldLabel>Description</FieldLabel>
          {hasHtmlTags(description) ? (
            <div
              className="text-sm text-foreground break-words prose prose-sm max-w-none prose-p:my-2 prose-a:text-brand prose-a:no-underline hover:prose-a:underline prose-headings:text-foreground prose-strong:text-foreground prose-code:text-foreground prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:before:content-none prose-code:after:content-none"
              dangerouslySetInnerHTML={{ __html: sanitizeHtml(description) }}
            />
          ) : (
            <p className="text-sm text-foreground whitespace-pre-wrap break-words leading-relaxed">
              {description}
            </p>
          )}
        </section>
      )}

      {/* Reference link */}
      {reference && (
        <a
          href={reference}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-xs text-brand hover:text-brand/80 underline break-all"
        >
          <ExternalLink className="w-3.5 h-3.5 shrink-0" />
          {reference}
        </a>
      )}

      {/* Empty state */}
      {!description && !reference && !baseModel && sources.length === 0 && !model.gated
        && !triggers.length && !tags.length && (
        <div className="empty-box">No details available.</div>
      )}
    </div>
  );
}
