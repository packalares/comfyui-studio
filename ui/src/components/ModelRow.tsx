import { memo } from 'react';
import {
  Trash2, Loader2, Download, X, Lock, AlertTriangle, ExternalLink, Info,
} from 'lucide-react';
import type { CatalogModel, DownloadState, CivitaiModelSummary } from '../types';
import { formatBytes } from '../lib/utils';
import { Tooltip, TooltipTrigger, TooltipContent } from './ui/tooltip';

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
  // Info button is suppressed when the model carries nothing useful to show —
  // avoids dead buttons on minimal catalog entries.
  const hasInfo = !!(model.description || model.reference || model.base);
  // Show the in-flight state when either a live WS download arrived OR the
  // catalog row carries `downloading: true` (pre-populated at download-start).
  const isDownloading = !!download || !!model.downloading;

  return (
    <div className="flex items-center gap-3 py-2.5 px-4 hover:bg-slate-50">
      {model.thumbnail ? (
        <img
          src={model.thumbnail}
          alt=""
          width={32}
          height={32}
          loading="lazy"
          decoding="async"
          className="w-8 h-8 rounded object-cover ring-1 ring-slate-200 bg-slate-100 shrink-0"
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
        />
      ) : null}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-slate-900 truncate">
          {model.filename || model.name}
        </p>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          {showTypeBadge && model.type && (
            <span className="badge-pill badge-slate">{model.type}</span>
          )}
          {model.fileSize ? (
            <span className="text-[11px] text-slate-500">{formatBytes(model.fileSize)}</span>
          ) : model.size_bytes ? (
            <span className="text-[11px] text-slate-500">{model.size_pretty || formatBytes(model.size_bytes)}</span>
          ) : null}
          {isDownloading ? (
            <span className="badge-pill badge-teal">
              <Loader2 className="w-3 h-3 animate-spin" /> Downloading
            </span>
          ) : model.installed && model.fileStatus !== 'corrupt' && model.fileStatus !== 'incomplete' ? (
            <span className="badge-pill badge-emerald">Installed</span>
          ) : model.fileStatus === 'corrupt' ? (
            <span
              className="badge-pill bg-red-50 text-red-700 ring-red-200 inline-flex items-center gap-1"
              title={`On disk: ${formatBytes(model.fileSize || 0)} — expected ${model.size_pretty || formatBytes(model.size_bytes)}`}
            >
              <AlertTriangle className="w-3 h-3" /> Corrupt
            </span>
          ) : model.fileStatus === 'incomplete' ? (
            <span
              className="badge-pill badge-amber"
              title={`On disk: ${formatBytes(model.fileSize || 0)} — expected ${model.size_pretty || formatBytes(model.size_bytes)}`}
            >
              <AlertTriangle className="w-3 h-3" /> Incomplete
            </span>
          ) : (
            <span className="text-[11px] text-slate-400">Not installed</span>
          )}
          {model.gated && (
            <span
              className="badge-pill bg-slate-100 text-slate-700 ring-slate-300 inline-flex items-center gap-1"
              title={model.gated_message || 'Requires HuggingFace token'}
            >
              <Lock className="w-3 h-3" /> Gated
            </span>
          )}
          {isRequired && selectedWorkflow && (
            <span className="badge-pill badge-amber">Required</span>
          )}
        </div>
        {model.error && !isDownloading && !model.installed && (
          <p className="text-[11px] text-rose-600 mt-1" title={model.error}>
            Download failed: <span className="font-mono">{model.error}</span>
          </p>
        )}
      </div>
      <div className="shrink-0 flex items-center gap-2">
        {download && download.status === 'queued' ? (
          <span className="badge-pill bg-slate-100 text-slate-600 ring-slate-200 inline-flex items-center gap-1">
            <Loader2 className="w-3 h-3 animate-spin" /> Queued
          </span>
        ) : download ? (
          <div className="flex items-center gap-2">
            <div className="w-24">
              <div className="flex justify-between text-[10px] text-slate-500 mb-0.5">
                <span>{Math.round(download.progress)}%</span>
              </div>
              <div className="progress-track">
                <div
                  className="progress-bar-fill"
                  style={{ width: `${download.progress}%` }}
                />
              </div>
            </div>
            <button
              onClick={() => onCancelDownload(model.name, download.downloadId)}
              className="btn-icon"
              title="Cancel download"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ) : (
          // Normal state: primary action + optional Info in a connected
          // btn-group that mirrors Explore's CivitaiTemplateCard footer.
          <div className="btn-group">
            {model.installed && onDelete ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => onDelete(model)}
                    className="btn-secondary hover:!bg-red-50 hover:!border-red-200 hover:!text-red-600"
                    aria-label="Delete model"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Delete
                  </button>
                </TooltipTrigger>
                <TooltipContent>Delete this model</TooltipContent>
              </Tooltip>
            ) : model.gated && !hfTokenConfigured ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={onNavigateSettings}
                    className="btn-primary"
                    aria-label="Configure HuggingFace token"
                  >
                    <Lock className="w-3.5 h-3.5" />
                    HF token
                  </button>
                </TooltipTrigger>
                <TooltipContent>{model.gated_message || 'Requires HuggingFace token — click to configure'}</TooltipContent>
              </Tooltip>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => onInstall(item)}
                    className="btn-primary"
                    aria-label="Download model"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Download
                  </button>
                </TooltipTrigger>
                <TooltipContent>Download this model</TooltipContent>
              </Tooltip>
            )}
            {onShowInfo && hasInfo && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => onShowInfo(item)}
                    aria-label="Description"
                    className="btn-secondary"
                  >
                    <Info className="w-3.5 h-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Description</TooltipContent>
              </Tooltip>
            )}
          </div>
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
    <div className="flex items-center gap-3 py-2.5 px-4 hover:bg-slate-50">
      {civ.thumbnail ? (
        <img
          src={civ.thumbnail}
          alt=""
          width={32}
          height={32}
          loading="lazy"
          decoding="async"
          className="w-8 h-8 rounded object-cover ring-1 ring-slate-200 bg-slate-100 shrink-0"
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
        />
      ) : null}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-slate-900 truncate" title={civ.item.name}>
          {civ.item.name}
        </p>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          {showTypeBadge && civ.item.type && (
            <span className="badge-pill badge-slate">{civ.item.type}</span>
          )}
          {civ.sizeBytes && (
            <span className="text-[11px] text-slate-500">{formatBytes(civ.sizeBytes)}</span>
          )}
          {creator && <span className="text-[11px] text-slate-500">by {creator}</span>}
          {typeof downloads === 'number' && (
            <span className="text-[11px] text-slate-500">{downloads.toLocaleString()} dl</span>
          )}
          {primaryVersion?.baseModel && (
            <span className="badge-pill badge-slate !text-[10px]">{primaryVersion.baseModel}</span>
          )}
          <span className="badge-pill badge-teal">CivitAI</span>
        </div>
        {civ.error && (
          <p className="text-[11px] text-rose-600 mt-1" title={civ.error}>
            {civ.error}
          </p>
        )}
      </div>
      <div className="shrink-0 btn-group">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => onInstall(item)}
              disabled={civ.busy}
              className="btn-primary"
              aria-label={civ.busy ? 'Starting download' : civ.copied ? 'Download started' : 'Download model'}
            >
              {civ.busy
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Download className="w-3.5 h-3.5" />}
              {civ.copied ? 'Started' : 'Download'}
            </button>
          </TooltipTrigger>
          <TooltipContent>
            {civ.busy ? 'Starting download…' : civ.copied ? 'Download started' : 'Download this model'}
          </TooltipContent>
        </Tooltip>
        {onShowInfo && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onShowInfo(item)}
                aria-label="Description"
                className="btn-secondary"
              >
                <Info className="w-3.5 h-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Description</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <a
              href={pageUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open on civitai.com"
              className="btn-secondary"
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </TooltipTrigger>
          <TooltipContent>Open on civitai.com</TooltipContent>
        </Tooltip>
      </div>
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
