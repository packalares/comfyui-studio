import { memo, useMemo, useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Image, Video, Music, Box, HardDrive, Cpu,
  MoreHorizontal, Trash2, Loader2, ExternalLink, FileJson, Check, ImageOff,
  Puzzle, Info, Wand2, Download, User as UserIcon, Braces,
} from 'lucide-react';
import type { Template, CivitaiModelSummary, StagedImportManifest, RequiredModel } from '../types';
import { formatBytes } from '../lib/utils';
import { imgProxy } from '../lib/imgProxy';
import { api } from '../services/comfyui';
import DescriptionModal from './DescriptionModal';
import DependencyModal from './DependencyModal';
import ApiExportModal from './ApiExportModal';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from './ui/alert-dialog';

interface Props {
  template: Template;
  /** Called after a successful delete so parent can refresh + show a toast. */
  onDeleted?: (name: string) => void;
}

const mediaIcons: Record<string, React.ElementType> = {
  image: Image,
  video: Video,
  audio: Music,
  '3d': Box,
};

const gradientMap: Record<string, string> = {
  image: 'from-blue-400 to-blue-600',
  video: 'from-purple-400 to-purple-600',
  audio: 'from-orange-400 to-orange-600',
  '3d': 'from-green-400 to-green-600',
};

/** Compact download-count formatter: 3640 → "3.6k", 1_234_567 → "1.2M". */
function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

function TemplateCardInner({ template, onDeleted }: Props) {
  const navigate = useNavigate();
  const Icon = mediaIcons[template.mediaType] || Image;
  const gradient = gradientMap[template.mediaType] || 'from-gray-400 to-gray-600';
  // User-imported workflows use this category marker — see
  // server/src/services/templates/userTemplates.ts::saveUserWorkflow.
  const isUser = template.category === 'User Workflows';

  const uniqueTags = useMemo(
    () => Array.from(new Set(template.tags)).slice(0, 3),
    [template.tags],
  );
  // Civitai origin meta — when present we render a small source badge next
  // to the title. Civitai-specific tags are shown in the DescriptionModal,
  // not on the card, to keep the tag row consistent across sources.
  const civitaiMeta = template.civitaiMeta;

  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [installingPlugins, setInstallingPlugins] = useState(false);
  const [descOpen, setDescOpen] = useState(false);
  const [apiOpen, setApiOpen] = useState(false);
  const [depsOpen, setDepsOpen] = useState(false);
  const [depsLoading, setDepsLoading] = useState(false);
  const [depsMissing, setDepsMissing] = useState<RequiredModel[] | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Plugin chip surfaces only when the template declares any plugins AND at
  // least one is not installed. The `installed` flag is filled in by the
  // template list endpoint once Phase 2 backend plumbing is wired; for
  // now we treat "no installed flag set" as missing so the chip surfaces
  // on fresh imports.
  const missingPlugins = useMemo(() => {
    const list = template.plugins ?? [];
    return list.filter((p) => p.installed !== true);
  }, [template.plugins]);

  const handleInstallMissing = useCallback(async () => {
    setInstallingPlugins(true);
    try {
      const result = await api.installMissingPlugins(template.name);
      const queued = result.queued.length;
      const skipped = result.alreadyInstalled.length;
      const unknown = result.unknown.length;
      toast.success(
        `Plugin install queued: ${queued} queued, ${skipped} already installed${unknown > 0 ? `, ${unknown} unknown` : ''}.`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Install failed');
    } finally {
      setInstallingPlugins(false);
    }
  }, [template.name]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  const handleCardClick = (): void => {
    const cat = template.studioCategory || template.mediaType || 'image';
    navigate(`/studio/${encodeURIComponent(template.name)}?category=${cat}`);
  };

  const handleInstallDeps = useCallback(async (): Promise<void> => {
    // Fetch missing deps lazily — cards are rendered in grids, so we don't
    // pay the round-trip unless the user actually clicks the button.
    setDepsLoading(true);
    try {
      const res = await api.checkDependencies(template.name);
      setDepsMissing(res.missing);
      setDepsOpen(true);
    } catch (err) {
      toast.error('Failed to check dependencies', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setDepsLoading(false);
    }
  }, [template.name]);

  const handleConfirmDelete = useCallback(async () => {
    setDeleting(true);
    try {
      await api.deleteTemplate(template.name);
      setConfirmOpen(false);
      onDeleted?.(template.name);
    } catch (err) {
      console.error('Delete template failed:', err);
    } finally {
      setDeleting(false);
    }
  }, [template.name, onDeleted]);

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={handleCardClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleCardClick();
          }
        }}
        className="card text-left group cursor-pointer overflow-hidden flex flex-col h-full relative"
      >
        <div className="aspect-video shrink-0 relative flex items-center justify-center overflow-hidden">
          {(() => {
            // Thumbnail resolution:
            //   - Absolute URL (user imports: civitai/HF CDN) → route through
            //     the image proxy for resize + disk cache.
            //   - Otherwise → upstream ComfyUI template: the real preview
            //     ALWAYS lives at `<name>-1.webp` alongside the workflow
            //     JSON. The `thumbnail[]` field in the index is a
            //     category hint (output/input/thumbnail), not a filesystem
            //     path, and isn't served by ComfyUI's HTTP layer.
            if (!template.name) {
              return (
                <div className={`w-full h-full bg-gradient-to-br ${gradient} flex items-center justify-center`}>
                  <Icon className="w-10 h-10 text-white/60 group-hover:text-white/80 transition-colors" />
                </div>
              );
            }
            const saved = template.thumbnail?.[0];
            const src = saved && /^https?:\/\//i.test(saved)
              ? (imgProxy(saved, 320) ?? saved)
              : `/api/template-asset/${template.name}-1.webp`;
            return (
              <img
                src={src}
                alt={template.title}
                className="w-full h-full object-cover"
                width={320}
                height={180}
                loading="lazy"
                decoding="async"
                onError={(e) => {
                  const target = e.currentTarget;
                  target.style.display = 'none';
                  target.parentElement?.classList.add('bg-gradient-to-br', ...gradient.split(' '));
                }}
              />
            );
          })()}
          <div className="absolute top-2 right-2 flex items-center gap-1.5">
            {template.ready === true && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-500/90 text-white">
                Ready
              </span>
            )}
            {isUser && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-teal-500/90 text-white">
                User
              </span>
            )}
            {template.openSource !== undefined && (
              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                template.openSource
                  ? 'bg-green-500/90 text-white'
                  : 'bg-gray-500/80 text-white'
              }`}>
                {template.openSource ? 'Open Source' : 'API'}
              </span>
            )}
            <span className={`badge ${
              template.mediaType === 'image' ? 'badge-blue' :
              template.mediaType === 'video' ? 'badge-purple' :
              template.mediaType === 'audio' ? 'badge-orange' :
              'badge-gray'
            }`}>
              {template.mediaType}
            </span>
          </div>
          {/* Overflow menu — user-imported workflows only. Absolutely positioned
              on top of the thumbnail; clicking never propagates to the card. */}
          {isUser && (
            <div
              ref={menuRef}
              className="absolute top-2 left-2"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                aria-label="Template actions"
                className="btn-icon !bg-white/90 hover:!bg-white ring-1 ring-slate-200"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen((v) => !v);
                }}
              >
                <MoreHorizontal className="w-4 h-4" />
              </button>
              {menuOpen && (
                <div
                  role="menu"
                  className="absolute top-9 left-0 z-10 min-w-[10rem] rounded-md border border-slate-200 bg-white shadow-lg p-1"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuOpen(false);
                      setConfirmOpen(true);
                    }}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs text-red-600 hover:bg-red-50"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Delete template
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="p-4 flex flex-col flex-1">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="font-semibold text-sm text-gray-900 group-hover:text-teal-600 transition-colors line-clamp-1 flex-1 min-w-0">
              {template.title}
            </h3>
            {civitaiMeta && (
              <span
                className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-teal-500/90 text-white shrink-0"
                title={civitaiMeta.originalUrl ?? `CivitAI model ${civitaiMeta.modelId}`}
              >
                CivitAI
              </span>
            )}
          </div>
          <div className="mt-auto">
            {/* Stats row */}
            <div className="flex items-center gap-3 mb-3 text-[11px] text-gray-400">
              {template.size !== undefined && (
                <span className="flex items-center gap-1">
                  <HardDrive className="w-3 h-3" />
                  {template.size === 0 ? 'Cloud API' : formatBytes(template.size)}
                </span>
              )}
              {template.vram !== undefined && template.vram > 0 && (
                <span className="flex items-center gap-1">
                  <Cpu className="w-3 h-3" />
                  {formatBytes(template.vram)}
                </span>
              )}
            </div>

            {uniqueTags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {uniqueTags.map(tag => (
                  <span key={tag} className="text-[10px] text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded">
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
        {/* Footer — icon-only button group, right-aligned. Install-plugins
            only renders when Manager reports at least one missing plugin. */}
        <div
          className="border-t border-slate-200 p-3 flex justify-end"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="btn-group">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={(e) => { e.stopPropagation(); handleCardClick(); }}
                  aria-label="Use in Studio"
                >
                  <Wand2 className="w-3.5 h-3.5" />
                  Use
                </button>
              </TooltipTrigger>
              <TooltipContent>Open this workflow in the Studio</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={(e) => { e.stopPropagation(); setDescOpen(true); }}
                  aria-label="Description"
                >
                  <Info className="w-3.5 h-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Description</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={(e) => { e.stopPropagation(); void handleInstallDeps(); }}
                  disabled={depsLoading}
                  aria-label="Install dependencies"
                >
                  {depsLoading ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Download className="w-3.5 h-3.5" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent>Install dependencies</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={(e) => { e.stopPropagation(); setApiOpen(true); }}
                  aria-label="Export API prompt"
                >
                  <Braces className="w-3.5 h-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Export API JSON (what we'd send to ComfyUI)</TooltipContent>
            </Tooltip>
            {missingPlugins.length > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={(e) => { e.stopPropagation(); void handleInstallMissing(); }}
                    disabled={installingPlugins}
                    aria-label={`Install ${missingPlugins.length} missing plugin${missingPlugins.length === 1 ? '' : 's'}`}
                  >
                    {installingPlugins ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Puzzle className="w-3.5 h-3.5" />
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  {installingPlugins ? 'Queuing plugin installs…' : `Install ${missingPlugins.length} missing plugin${missingPlugins.length === 1 ? '' : 's'}`}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
      </div>

      <DescriptionModal
        open={descOpen}
        onClose={() => setDescOpen(false)}
        title={template.title}
        description={template.description}
        tags={template.tags}
        models={template.models}
        civitaiMeta={civitaiMeta}
      />
      <ApiExportModal
        open={apiOpen}
        templateName={template.name}
        onClose={() => setApiOpen(false)}
      />
      {depsOpen && depsMissing !== null && (
        <DependencyModal
          missing={depsMissing}
          onClose={() => { setDepsOpen(false); setDepsMissing(null); }}
          onDownloadComplete={() => { setDepsOpen(false); setDepsMissing(null); }}
        />
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete template?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the user-imported workflow{' '}
              <span className="font-mono text-slate-700">{template.title}</span>{' '}
              from your library. The underlying models on disk are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              disabled={deleting}
              className="!bg-red-600 hover:!bg-red-700"
            >
              {deleting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Trash2 className="w-3.5 h-3.5" />
              )}
              {deleting ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

const TemplateCard = memo(TemplateCardInner);
export default TemplateCard;

// --- CivitAI workflow card (Explore Source=CivitAI) ----------------------

/**
 * Rewrite a civitai CDN URL to request a smaller preview size. Civitai
 * serves variants via the `/width=NUMBER/` segment (e.g. `.../width=450/...`).
 * Swap to `width` for grid thumbnails so a 24-card Explore page doesn't pull
 * 24 × several MB of full-res images.
 *
 * URL shapes handled:
 *  - `https://image.civitai.com/xG1n.../width=450/0001.jpeg` -> swap width
 *  - `https://image.civitai.com/xG1n.../0001.jpeg` -> inject `/width=320/`
 *    after the `/image/` segment when we recognise the civitai-CDN format
 *  - anything else -> return untouched (don't invent)
 */
export function downsizeCivitaiImageUrl(url: string, width: number): string {
  if (!url) return url;
  if (/\/width=\d+\//.test(url)) {
    return url.replace(/\/width=\d+\//, `/width=${width}/`);
  }
  // Pattern match civitai's CDN host; when the URL ends in an image filename
  // we inject the width segment just before it.
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (!host.endsWith('image.civitai.com') && !host.endsWith('civitai.com')) return url;
    const parts = u.pathname.split('/').filter((p) => p.length > 0);
    if (parts.length === 0) return url;
    const last = parts[parts.length - 1];
    if (!/\.(png|jpe?g|webp)$/i.test(last)) return url;
    const newParts = [...parts.slice(0, parts.length - 1), `width=${width}`, last];
    u.pathname = `/${newParts.join('/')}`;
    return u.toString();
  } catch {
    return url;
  }
}

/** Pick the most usable preview thumbnail for a civitai card. Returns the
 * original upstream URL; callers pass it through `imgProxy()` to get the
 * backend-resized variant. */
function pickThumbnail(item: CivitaiModelSummary): string | null {
  for (const version of item.modelVersions ?? []) {
    for (const image of version.images ?? []) {
      const url = image.url;
      if (url && (image.type === undefined || image.type === 'image')) {
        return url;
      }
    }
  }
  return null;
}

/**
 * A CivitAI workflow rendered as a TemplateCard-shaped tile. Reuses the same
 * outer `card` class + thumbnail layout so the Explore grid looks uniform
 * whether the current source is local or remote.
 *
 * Primary action = "Import as template" (pipes the workflow JSON through
 * the existing /templates/import-civitai endpoint). Secondary action opens
 * the item on civitai.com.
 */
interface CivitaiTemplateCardProps {
  item: CivitaiModelSummary;
  /**
   * Called when a civitai zip contains multiple workflows. Receives the
   * staged manifest so the parent can pop the import-review modal with the
   * workflows preselected.
   */
  onStagedImport?: (manifest: StagedImportManifest) => void;
}

function CivitaiTemplateCardInner({ item, onStagedImport }: CivitaiTemplateCardProps) {
  const thumb = pickThumbnail(item);
  const primaryVersion = item.modelVersions?.[0];
  const creator = item.creator?.username;
  const downloads = item.stats?.downloadCount;
  const pageUrl = `https://civitai.com/models/${item.id}`;

  const [importing, setImporting] = useState(false);
  const [imported] = useState(false);
  const [descOpen, setDescOpen] = useState(false);

  const handleImport = async (): Promise<void> => {
    // Backend always stages (JSON → stageFromJson, ZIP → stageFromZip) and
    // returns a manifest the review modal walks through. The modal handles
    // selection + plugin install + commit.
    if (!primaryVersion?.id) {
      toast.error('CivitAI import unavailable', {
        description: 'This item has no downloadable version.',
      });
      return;
    }
    setImporting(true);
    try {
      const result = await api.importCivitaiWorkflow(primaryVersion.id);
      if (onStagedImport) {
        onStagedImport(result.manifest);
      } else {
        toast.error('CivitAI import unavailable', {
          description: 'Explore is required to review the staged import.',
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Import failed';
      // Surface upstream HTTP status codes (e.g. 401 Unauthorized) as a
      // friendlier toast. Falls back to the raw message when no status is
      // present in the error text.
      const statusMatch = /\b(\d{3})\b/.exec(msg);
      const status = statusMatch ? Number(statusMatch[1]) : null;
      if (status === 401) {
        toast.error('CivitAI download failed', {
          description: '401 Unauthorized. The model may require an API token or a logged-in session.',
        });
      } else if (status && status >= 400) {
        toast.error('CivitAI download failed', {
          description: `${status} — ${msg}`,
        });
      } else {
        toast.error('CivitAI import failed', { description: msg });
      }
    } finally {
      setImporting(false);
    }
  };

  return (
    <article className="card overflow-hidden flex flex-col h-full">
      <div className="aspect-video shrink-0 relative flex items-center justify-center overflow-hidden bg-slate-100">
        {thumb ? (
          <img
            src={imgProxy(thumb, 320)}
            alt={item.name}
            width={320}
            height={180}
            loading="lazy"
            decoding="async"
            className="w-full h-full object-cover"
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-slate-300">
            <ImageOff className="w-10 h-10" />
          </div>
        )}
        <div className="absolute top-2 right-2 flex items-center gap-1.5">
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-teal-500/90 text-white">
            CivitAI
          </span>
          {item.type && (
            <span className="badge badge-gray !bg-white/90 !text-slate-700">
              {item.type}
            </span>
          )}
        </div>
      </div>
      <div className="p-4 flex flex-col flex-1">
        <h3 className="font-semibold text-sm text-gray-900 mb-1 line-clamp-1" title={item.name}>
          {item.name}
        </h3>
        <div className="flex items-center justify-between gap-2 mb-2">
          {creator ? (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-slate-50 px-2 py-0.5 text-[10px] font-normal text-slate-500 ring-1 ring-inset ring-slate-200/70 max-w-[60%]"
              title={creator}
            >
              <UserIcon className="w-2.5 h-2.5 shrink-0" />
              <span className="truncate">{creator}</span>
            </span>
          ) : <span />}
          {typeof downloads === 'number' && (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-slate-50 px-2 py-0.5 text-[10px] font-normal text-slate-500 ring-1 ring-inset ring-slate-200/70"
              title={`${downloads.toLocaleString()} downloads`}
            >
              <Download className="w-2.5 h-2.5" />
              {formatCompact(downloads)}
            </span>
          )}
        </div>
      </div>
      {/* Footer — icon-only button group, right-aligned. */}
      <div className="border-t border-slate-200 p-3 flex justify-end">
        <div className="btn-group">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleImport}
                disabled={importing}
                className="btn-primary"
                aria-label={importing ? 'Importing' : imported ? 'Imported' : 'Import workflow'}
              >
                {importing ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : imported ? (
                  <Check className="w-3.5 h-3.5" />
                ) : (
                  <FileJson className="w-3.5 h-3.5" />
                )}
                {importing ? 'Importing…' : imported ? 'Imported' : 'Import'}
              </button>
            </TooltipTrigger>
            <TooltipContent>{importing ? 'Staging this civitai workflow…' : imported ? 'Already imported' : 'Stage this civitai workflow for review'}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setDescOpen(true)}
                aria-label="Description"
              >
                <Info className="w-3.5 h-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Description</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <a
                href={pageUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-secondary"
                aria-label="Open on civitai.com"
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </TooltipTrigger>
            <TooltipContent>Open on civitai.com</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <DescriptionModal
        open={descOpen}
        onClose={() => setDescOpen(false)}
        title={item.name}
        description={item.description ?? undefined}
        tags={item.tags}
        civitaiMeta={{
          modelId: item.id,
          originalUrl: pageUrl,
          description: item.description ?? undefined,
          tags: item.tags,
        }}
      />
    </article>
  );
}

export const CivitaiTemplateCard = memo(CivitaiTemplateCardInner);
