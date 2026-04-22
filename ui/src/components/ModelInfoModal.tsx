import { ExternalLink, Download as DownloadIcon, ThumbsUp, Star, HardDrive, User as UserIcon } from 'lucide-react';
import type { CatalogModel, CivitaiModelSummary } from '../types';
import { formatBytes } from '../lib/utils';
import AppModal from './AppModal';

// Allow-list of HTML tags we'll render for civitai descriptions. Mirrors the
// list in `DescriptionModal.tsx` — kept in sync deliberately because the
// backend ingests the same civitai payload shape.
const ALLOWED_TAGS = new Set([
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'code', 'pre',
  'ul', 'ol', 'li', 'blockquote', 'a',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);

function sanitizeHtml(raw: string): string {
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

function hasHtmlTags(s: string): boolean {
  return /<[a-z][\s\S]*?>/i.test(s);
}

export type ModelInfoSource =
  | { kind: 'civitai'; item: CivitaiModelSummary }
  | { kind: 'catalog'; model: CatalogModel };

interface Props {
  open: boolean;
  onClose: () => void;
  source: ModelInfoSource | null;
}

interface StatPillProps {
  icon: React.ElementType;
  label: string;
  value: string;
}

function StatPill({ icon: Icon, label, value }: StatPillProps) {
  return (
    <div className="inline-flex items-center gap-1.5 rounded-full bg-slate-50 px-2.5 py-1 text-[11px] ring-1 ring-inset ring-slate-200">
      <Icon className="w-3 h-3 text-slate-500" />
      <span className="text-slate-500">{label}</span>
      <span className="font-mono font-semibold text-slate-800">{value}</span>
    </div>
  );
}

/** Compact human formatter for counts: 3640 → "3.6k". */
function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/**
 * Read-only info dialog for a model — the Models page equivalent of
 * `DescriptionModal` but tuned for model metadata (creator, stats, primary
 * file format/size, source URL). Renders for both CivitAI remote rows and
 * local catalog rows.
 */
export default function ModelInfoModal({ open, onClose, source }: Props): JSX.Element | null {
  if (!open || !source) return null;

  if (source.kind === 'civitai') {
    const item = source.item;
    const creator = item.creator?.username;
    const description = item.description ?? '';
    const primaryVersion = item.modelVersions?.[0];
    const primaryFile = primaryVersion?.files?.[0];
    const sizeBytes = typeof primaryFile?.sizeKB === 'number'
      ? Math.round(primaryFile.sizeKB * 1024)
      : null;
    const fileFormat = primaryFile?.name?.split('.').pop()?.toLowerCase();
    const pageUrl = `https://civitai.com/models/${item.id}`;
    const stats = item.stats ?? {};
    const tags = item.tags ?? [];

    return (
      <AppModal
        open={open}
        onClose={onClose}
        title={item.name}
        subtitle={item.type ? `${item.type} — CivitAI` : 'CivitAI'}
        size="md"
      >
        <div className="space-y-4">
          {creator && (
            <div className="inline-flex items-center gap-1.5 rounded-full bg-slate-50 px-2.5 py-1 text-xs ring-1 ring-inset ring-slate-200">
              <UserIcon className="w-3 h-3 text-slate-500" />
              <span className="text-slate-500">by</span>
              <span className="font-medium text-slate-800">{creator}</span>
            </div>
          )}

          {(typeof stats.downloadCount === 'number'
            || typeof stats.thumbsUpCount === 'number'
            || typeof stats.favoriteCount === 'number') && (
            <div className="flex flex-wrap gap-1.5">
              {typeof stats.downloadCount === 'number' && (
                <StatPill icon={DownloadIcon} label="downloads" value={formatCompact(stats.downloadCount)} />
              )}
              {typeof stats.thumbsUpCount === 'number' && (
                <StatPill icon={ThumbsUp} label="likes" value={formatCompact(stats.thumbsUpCount)} />
              )}
              {typeof stats.favoriteCount === 'number' && (
                <StatPill icon={Star} label="favourites" value={formatCompact(stats.favoriteCount)} />
              )}
            </div>
          )}

          {(sizeBytes || fileFormat || primaryVersion?.baseModel) && (
            <section>
              <h3 className="field-label mb-1.5">Version</h3>
              <div className="flex flex-wrap gap-1.5">
                {primaryVersion?.baseModel && (
                  <span className="badge-pill badge-slate">{primaryVersion.baseModel}</span>
                )}
                {fileFormat && (
                  <span className="badge-pill badge-slate">.{fileFormat}</span>
                )}
                {sizeBytes !== null && (
                  <StatPill icon={HardDrive} label="size" value={formatBytes(sizeBytes)} />
                )}
              </div>
            </section>
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
                <p className="text-xs text-slate-700 whitespace-pre-wrap break-words">
                  {description}
                </p>
              )}
            </section>
          )}

          {tags.length > 0 && (
            <section>
              <h3 className="field-label mb-1.5">Tags</h3>
              <div className="flex flex-wrap gap-1.5">
                {tags.map((tag) => (
                  <span key={tag} className="badge-pill badge-slate">
                    {tag}
                  </span>
                ))}
              </div>
            </section>
          )}

          <a
            href={pageUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-teal-700 hover:text-teal-800 underline"
          >
            <ExternalLink className="w-3 h-3" />
            Open on civitai.com
          </a>
        </div>
      </AppModal>
    );
  }

  const model = source.model;
  const description = model.description ?? '';
  const reference = model.reference;
  const fileFormat = (model.filename || model.name).split('.').pop()?.toLowerCase();

  return (
    <AppModal
      open={open}
      onClose={onClose}
      title={model.filename || model.name}
      subtitle={model.type ? `${model.type} — Local catalog` : 'Local catalog'}
      size="md"
    >
      <div className="space-y-4">
        <section>
          <h3 className="field-label mb-1.5">Details</h3>
          <div className="flex flex-wrap gap-1.5">
            {model.base && (
              <span className="badge-pill badge-slate">{model.base}</span>
            )}
            {fileFormat && (
              <span className="badge-pill badge-slate">.{fileFormat}</span>
            )}
            {model.installed ? (
              <span className="badge-pill badge-emerald">Installed</span>
            ) : (
              <span className="badge-pill badge-slate">Not installed</span>
            )}
            {(model.fileSize || model.size_bytes) && (
              <StatPill
                icon={HardDrive}
                label="size"
                value={formatBytes(model.fileSize || model.size_bytes)}
              />
            )}
          </div>
        </section>

        {description && (
          <section>
            <h3 className="field-label mb-1.5">Description</h3>
            {hasHtmlTags(description) ? (
              <div
                className="text-xs text-slate-700 break-words prose prose-sm max-w-none"
                dangerouslySetInnerHTML={{ __html: sanitizeHtml(description) }}
              />
            ) : (
              <p className="text-xs text-slate-700 whitespace-pre-wrap break-words">
                {description}
              </p>
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

        {!description && !reference && !model.base && (
          <div className="empty-box">No details available.</div>
        )}
      </div>
    </AppModal>
  );
}
