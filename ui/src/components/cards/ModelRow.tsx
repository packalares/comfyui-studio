import { memo, useEffect, useState } from 'react';
import {
  Trash2, Download, X, Lock, AlertTriangle, ExternalLink, Info, Star,
} from 'lucide-react';
import type { CatalogModel, DownloadState, CivitaiModelSummary } from '../../types';
import { api, modelPreviewUrl } from '../../services/comfyui';
import { formatBytes } from '../../lib/utils';
import { Tooltip, TooltipTrigger, TooltipContent } from '../ui/tooltip';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { ButtonGroup } from '../ui/button-group';
import { Spinner } from '../ui/spinner';

export interface ModelRowDownload {
  modelName: string;
  downloadId: string;
  progress: number;
  status: DownloadState['status'];
}

/**
 * Discriminated union of every row flavor the Models page can render. Keeps
 * the row layout uniform regardless of whether the item came from the local
 * catalog or from CivitAI's remote search. Callers build these at the source.
 */
export type ModelRowItem =
  | { kind: 'catalog'; model: CatalogModel }
  | {
      kind: 'civitai';
      item: CivitaiModelSummary;
      thumbnail: string | null;
      sizeBytes: number | null;
      busy: boolean;
      copied: boolean;
      error: string | null;
    };

interface Props {
  item: ModelRowItem;
  download?: ModelRowDownload;
  isRequired?: boolean;
  selectedWorkflow?: string;
  hfTokenConfigured: boolean;
  showTypeBadge?: boolean;
  onInstall: (item: ModelRowItem) => void;
  onDelete?: (model: CatalogModel) => void;
  onCancelDownload: (modelName: string, downloadId: string) => void;
  onNavigateSettings: () => void;
  /** Opens the ModelInfoModal for this row. Optional — when omitted the Info
   * button is suppressed so callers that don't wire it up don't render a
   * dead button. */
  onShowInfo?: (item: ModelRowItem) => void;
}

/** Module-level NSFW blur level cache — fetched once, shared across all rows. */
let _cachedNsfwBlurLevel: number | null = null;

function useNsfwBlurLevel(): number {
  const [level, setLevel] = useState(_cachedNsfwBlurLevel ?? 1);
  useEffect(() => {
    if (_cachedNsfwBlurLevel !== null) { setLevel(_cachedNsfwBlurLevel); return; }
    api.getModelSettings().then((s) => {
      _cachedNsfwBlurLevel = s.nsfwBlurLevel;
      setLevel(s.nsfwBlurLevel);
    }).catch(() => { /* use default */ });
  }, []);
  return level;
}

function CatalogRow({
  model, download, isRequired, selectedWorkflow, hfTokenConfigured, showTypeBadge,
  onInstall, onDelete, onCancelDownload, onNavigateSettings, item, onShowInfo,
}: {
  model: CatalogModel;
  download?: ModelRowDownload;
  isRequired: boolean;
  selectedWorkflow: string;
  hfTokenConfigured: boolean;
  showTypeBadge?: boolean;
  onInstall: (item: ModelRowItem) => void;
  onDelete?: (model: CatalogModel) => void;
  onCancelDownload: (modelName: string, downloadId: string) => void;
  onNavigateSettings: () => void;
  item: ModelRowItem;
  onShowInfo?: (item: ModelRowItem) => void;
}) {
  const nsfwBlurLevel = useNsfwBlurLevel();
  const enrichment = model.enrichment;
  const shouldBlur = typeof enrichment?.nsfw_level === 'number' && enrichment.nsfw_level >= nsfwBlurLevel && nsfwBlurLevel < 4;
  const twCount = enrichment?.trigger_words?.length ?? 0;

  // Info button is suppressed when the model carries nothing useful to show —
  // avoids dead buttons on minimal catalog entries. A URL/urlSources counts
  // as "useful info" because the Details modal renders the download sources
  // section even without a freeform description.
  const hasInfo = !!(
    model.description || model.reference || model.base
    || model.url || (model.urlSources && model.urlSources.length > 0)
    || enrichment?.trigger_words?.length || enrichment?.tags?.length
  );
  // Show the in-flight state when either a live WS download arrived OR the
  // catalog row carries `downloading: true` (pre-populated at download-start).
  const isDownloading = !!download || !!model.downloading;

  // Thumbnail fallback: local preview (only when sidecar advertises one) ->
  // remote thumbnail -> nothing. Without the sidecar guard, every row hits the
  // server with /models/preview/... 404 — wasteful and noisy in the console.
  const hasLocalPreview = !!model.enrichment?.preview_local_path;
  const localPreviewSrc = hasLocalPreview && model.save_path && model.filename
    ? modelPreviewUrl(model.save_path, model.filename)
    : null;
  const [thumbSrc, setThumbSrc] = useState<string | null>(localPreviewSrc ?? model.thumbnail ?? null);

  return (
    <div className="flex items-center gap-3 py-2.5 px-4 hover:bg-muted">
      {thumbSrc ? (
        <img
          src={thumbSrc}
          alt=""
          width={32}
          height={32}
          loading="lazy"
          decoding="async"
          className="w-8 h-8 rounded object-cover ring-1 ring-border bg-muted shrink-0"
          style={shouldBlur ? { filter: 'blur(8px)' } : undefined}
          onError={() => {
            if (thumbSrc === localPreviewSrc && model.thumbnail) {
              setThumbSrc(model.thumbnail);
            } else {
              setThumbSrc(null);
            }
          }}
        />
      ) : null}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate">
          {model.hfRepo ? (model.name || model.filename) : (model.filename || model.name)}
        </p>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          {showTypeBadge && model.type && (
            <Badge variant="neutral">{model.type}</Badge>
          )}
          {model.fileSize ? (
            <span className="text-[11px] text-muted-foreground">{formatBytes(model.fileSize)}</span>
          ) : model.size_bytes ? (
            <span className="text-[11px] text-muted-foreground">{model.size_pretty || formatBytes(model.size_bytes)}</span>
          ) : null}
          {isDownloading ? (
            <Badge variant="brand">
              <Spinner size="xs" /> Downloading
            </Badge>
          ) : model.installed && model.fileStatus !== 'corrupt' && model.fileStatus !== 'incomplete' ? (
            <Badge variant="success">Installed</Badge>
          ) : model.fileStatus === 'corrupt' ? (
            <Badge
              variant="danger"
              title={`On disk: ${formatBytes(model.fileSize || 0)} — expected ${model.size_pretty || formatBytes(model.size_bytes)}`}
            >
              <AlertTriangle className="w-3 h-3" /> Corrupt
            </Badge>
          ) : model.fileStatus === 'incomplete' ? (
            <Badge
              variant="warning"
              title={`On disk: ${formatBytes(model.fileSize || 0)} — expected ${model.size_pretty || formatBytes(model.size_bytes)}`}
            >
              <AlertTriangle className="w-3 h-3" /> Incomplete
            </Badge>
          ) : (
            <span className="text-[11px] text-muted-foreground">Not installed</span>
          )}
          {model.gated && (
            <Badge
              variant="neutral"
              title={model.gated_message || 'Requires HuggingFace token'}
            >
              <Lock className="w-3 h-3" /> Gated
            </Badge>
          )}
          {isRequired && selectedWorkflow && (
            <Badge variant="warning">Required</Badge>
          )}
          {enrichment?.favorite && (
            <Star className="w-3 h-3 text-warning fill-warning" aria-label="Favorited" />
          )}
          {twCount > 0 && (
            <Badge variant="neutral" className="!text-[10px]">{twCount} trigger{twCount !== 1 ? 's' : ''}</Badge>
          )}
        </div>
        {model.error && !isDownloading && !model.installed && (
          <p className="text-[11px] text-destructive mt-1" title={model.error}>
            Download failed: <span className="font-mono">{model.error}</span>
          </p>
        )}
      </div>
      <div className="shrink-0 flex items-center gap-2">
        {download && download.status === 'queued' ? (
          <Badge variant="neutral">
            <Spinner size="xs" /> Queued
          </Badge>
        ) : download ? (
          <div className="flex items-center gap-2">
            <div className="w-24">
              <div className="flex justify-between text-[10px] text-muted-foreground mb-0.5">
                <span>{Math.round(download.progress)}%</span>
              </div>
              <div className="progress-track">
                <div
                  className="progress-bar-fill"
                  style={{ width: `${download.progress}%` }}
                />
              </div>
            </div>
            <Button
              onClick={() => onCancelDownload(model.name, download.downloadId)}
              variant="ghost"
              size="icon"
              title="Cancel download"
            >
              <X className="w-4 h-4" />
            </Button>
          </div>
        ) : (
          // Normal state: primary action + optional Info in a connected
          // group that mirrors Explore's CivitaiTemplateCard footer.
          <ButtonGroup>
            {model.installed && onDelete ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    onClick={() => onDelete(model)}
                    variant="secondary"
                    className="hover:!bg-destructive/10 hover:!border-destructive/30 hover:!text-destructive"
                    aria-label="Delete model"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Delete
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Delete this model</TooltipContent>
              </Tooltip>
            ) : model.gated && !hfTokenConfigured ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    onClick={onNavigateSettings}
                    aria-label="Configure HuggingFace token"
                  >
                    <Lock className="w-3.5 h-3.5" />
                    HF token
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{model.gated_message || 'Requires HuggingFace token — click to configure'}</TooltipContent>
              </Tooltip>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    onClick={() => onInstall(item)}
                    aria-label="Download model"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Download
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Download this model</TooltipContent>
              </Tooltip>
            )}
            {onShowInfo && hasInfo && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    onClick={() => onShowInfo(item)}
                    aria-label="Description"
                    variant="secondary"
                  >
                    <Info className="w-3.5 h-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Description</TooltipContent>
              </Tooltip>
            )}
          </ButtonGroup>
        )}
      </div>
    </div>
  );
}

function CivitaiRow({
  civ, showTypeBadge, onInstall, item, onShowInfo,
}: {
  civ: Extract<ModelRowItem, { kind: 'civitai' }>;
  showTypeBadge?: boolean;
  onInstall: (item: ModelRowItem) => void;
  item: ModelRowItem;
  onShowInfo?: (item: ModelRowItem) => void;
}) {
  const pageUrl = `https://civitai.com/models/${civ.item.id}`;
  const creator = civ.item.creator?.username;
  const downloads = civ.item.stats?.downloadCount;
  const primaryVersion = civ.item.modelVersions?.[0];
  return (
    <div className="flex items-center gap-3 py-2.5 px-4 hover:bg-muted">
      {civ.thumbnail ? (
        <img
          src={civ.thumbnail}
          alt=""
          width={32}
          height={32}
          loading="lazy"
          decoding="async"
          className="w-8 h-8 rounded object-cover ring-1 ring-border bg-muted shrink-0"
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
        />
      ) : null}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate" title={civ.item.name}>
          {civ.item.name}
        </p>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          {showTypeBadge && civ.item.type && (
            <Badge variant="neutral">{civ.item.type}</Badge>
          )}
          {civ.sizeBytes && (
            <span className="text-[11px] text-muted-foreground">{formatBytes(civ.sizeBytes)}</span>
          )}
          {creator && <span className="text-[11px] text-muted-foreground">by {creator}</span>}
          {typeof downloads === 'number' && (
            <span className="text-[11px] text-muted-foreground">{downloads.toLocaleString()} dl</span>
          )}
          {primaryVersion?.baseModel && (
            <Badge variant="neutral" className="!text-[10px]">{primaryVersion.baseModel}</Badge>
          )}
          <Badge variant="brand">CivitAI</Badge>
        </div>
        {civ.error && (
          <p className="text-[11px] text-destructive mt-1" title={civ.error}>
            {civ.error}
          </p>
        )}
      </div>
      <ButtonGroup className="shrink-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              onClick={() => onInstall(item)}
              disabled={civ.busy}
              aria-label={civ.busy ? 'Starting download' : civ.copied ? 'Download started' : 'Download model'}
            >
              {civ.busy
                ? <Spinner size="sm" />
                : <Download className="w-3.5 h-3.5" />}
              {civ.copied ? 'Started' : 'Download'}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {civ.busy ? 'Starting download…' : civ.copied ? 'Download started' : 'Download this model'}
          </TooltipContent>
        </Tooltip>
        {onShowInfo && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                onClick={() => onShowInfo(item)}
                aria-label="Description"
                variant="secondary"
              >
                <Info className="w-3.5 h-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Description</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button asChild variant="secondary" aria-label="Open on civitai.com">
              <a
                href={pageUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Open on civitai.com</TooltipContent>
        </Tooltip>
      </ButtonGroup>
    </div>
  );
}

function ModelRow(props: Props) {
  const { item } = props;
  if (item.kind === 'civitai') {
    return (
      <CivitaiRow
        civ={item}
        showTypeBadge={props.showTypeBadge}
        onInstall={props.onInstall}
        item={item}
        onShowInfo={props.onShowInfo}
      />
    );
  }
  return (
    <CatalogRow
      model={item.model}
      download={props.download}
      isRequired={props.isRequired ?? false}
      selectedWorkflow={props.selectedWorkflow ?? ''}
      hfTokenConfigured={props.hfTokenConfigured}
      showTypeBadge={props.showTypeBadge}
      onInstall={props.onInstall}
      onDelete={props.onDelete}
      onCancelDownload={props.onCancelDownload}
      onNavigateSettings={props.onNavigateSettings}
      item={item}
      onShowInfo={props.onShowInfo}
    />
  );
}

export default memo(ModelRow);
