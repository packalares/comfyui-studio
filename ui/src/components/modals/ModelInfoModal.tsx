import { useState } from 'react';
import {
  ExternalLink, Download as DownloadIcon, ThumbsUp, Star, HardDrive,
  User as UserIcon, Sparkles,
} from 'lucide-react';
import type { CatalogModel, CivitaiModelSummary } from '../../types';
import { formatBytes } from '../../lib/utils';
import { api } from '../../services/comfyui';
import AppModal from './AppModal';
import {
  CatalogModelBody, sanitizeHtml, hasHtmlTags,
} from './ModelInfoModal.catalog';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Spinner } from '../ui/spinner';

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

function StatPill({ icon: Icon, label, value }: StatPillProps): JSX.Element {
  return (
    <div className="stat-pill">
      <Icon className="w-3 h-3 text-muted-foreground" />
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono font-semibold text-foreground">{value}</span>
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
 *
 * The catalog branch lives in `ModelInfoModal.catalog.tsx` so this file
 * stays close to the per-file size budget.
 */
export default function ModelInfoModal({ open, onClose, source }: Props): JSX.Element | null {
  if (!open || !source) return null;

  if (source.kind === 'catalog') {
    return <CatalogModalShell open={open} onClose={onClose} model={source.model} />;
  }

  // Civitai branch — kept in this file because it's tightly coupled to
  // `civitaiModelSummary` and not worth splitting yet.
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
      size="lg"
    >
      <div className="space-y-4">
        {creator && (
          <div className="stat-pill text-xs">
            <UserIcon className="w-3 h-3 text-muted-foreground" />
            <span className="text-muted-foreground">by</span>
            <span className="font-medium text-foreground">{creator}</span>
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
                <Badge variant="neutral">{primaryVersion.baseModel}</Badge>
              )}
              {fileFormat && (
                <Badge variant="neutral">.{fileFormat}</Badge>
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
                className="text-xs text-foreground break-words prose prose-sm max-w-none"
                dangerouslySetInnerHTML={{ __html: sanitizeHtml(description) }}
              />
            ) : (
              <p className="text-xs text-foreground whitespace-pre-wrap break-words">
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
                <Badge key={tag} variant="neutral">
                  {tag}
                </Badge>
              ))}
            </div>
          </section>
        )}

        <a
          href={pageUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-brand hover:text-brand/90 underline"
        >
          <ExternalLink className="w-3 h-3" />
          Open on civitai.com
        </a>
      </div>
    </AppModal>
  );
}

// CatalogModalShell — wraps `CatalogModelBody` with state-owning chrome so the
// Enrich + Favorite buttons can sit INLINE with the subtitle text (not in the
// body). State lives here because AppModal's `subtitle` slot is a ReactNode
// rendered above the body; the buttons need shared access to enriching /
// favorite state with the body, but the body itself no longer renders them.
function CatalogModalShell({
  open, onClose, model,
}: { open: boolean; onClose: () => void; model: CatalogModel }): JSX.Element {
  const [enriching, setEnriching] = useState(false);
  const [enrichError, setEnrichError] = useState<string | null>(null);
  const [favorite, setFavorite] = useState(model.enrichment?.favorite ?? false);

  const onEnrich = () => {
    setEnriching(true);
    setEnrichError(null);
    api.enrichModel(model.save_path, model.filename)
      .then(() => { window.location.reload(); })
      .catch((err: unknown) => {
        setEnrichError(err instanceof Error ? err.message : 'Enrichment failed');
        setEnriching(false);
      });
  };

  const onToggleFavorite = () => {
    const next = !favorite;
    setFavorite(next);
    api.setModelFavorite(model.save_path, model.filename, next)
      .catch(() => setFavorite(!next));
  };

  const enrichmentSource = model.enrichment?.metadata_source;
  const typePrefix = model.type ? `${model.type} — ` : '';
  let subtitleSuffix: string;
  if (enrichmentSource === 'civitai') subtitleSuffix = 'CivitAI';
  else if (typeof model.source === 'string' && model.source.startsWith('template:')) subtitleSuffix = 'Template';
  else if (typeof model.source === 'string' && model.source.startsWith('enrichment:')) subtitleSuffix = 'CivitAI';
  else subtitleSuffix = 'Local catalog';
  const subtitleText = `${typePrefix}${subtitleSuffix}`;

  // Subtitle = text + inline action buttons. AppModal's subtitle slot already
  // sits under the title; the flex row keeps the buttons aligned with text.
  const subtitleNode = (
    <div className="flex items-center gap-2 flex-wrap">
      <span>{subtitleText}</span>
      {model.installed && (
        <>
          <Button
            type="button"
            onClick={onEnrich}
            disabled={enriching}
            variant="secondary"
            size="sm"
            className="h-6 px-2 text-[11px]"
          >
            {enriching ? <Spinner size="xs" /> : <Sparkles className="w-3 h-3" />}
            Enrich
          </Button>
          <button
            type="button"
            onClick={onToggleFavorite}
            aria-label={favorite ? 'Remove from favorites' : 'Add to favorites'}
            title={favorite ? 'Remove from favorites' : 'Add to favorites'}
            className="inline-flex items-center justify-center h-6 w-6 rounded hover:bg-muted text-muted-foreground hover:text-warning transition-colors"
          >
            <Star className={`w-3.5 h-3.5 ${favorite ? 'text-warning fill-warning' : ''}`} />
          </button>
          {enrichError && (
            <span className="text-[11px] text-destructive">{enrichError}</span>
          )}
        </>
      )}
    </div>
  );

  return (
    <AppModal
      open={open}
      onClose={onClose}
      title={model.filename || model.name}
      subtitle={subtitleNode}
      size="lg"
    >
      <CatalogModelBody model={model} />
    </AppModal>
  );
}
