// Detail modal for a single gallery item. Wave F redesign:
// - Visual language matches `ImportWorkflowModal` (panel shell, panel-header
//   row, panel-footer button strip).
// - Shows full metadata (prompt, seed, model, sampler, steps, cfg,
//   dimensions, template) captured from ComfyUI history at execution time.
// - Download + Delete preserved. Regenerate is new and disables with a
//   tooltip when the row has no stored workflow (pre-Wave-F imports).
//
// The modal owns the `regenerating` spinner state, the `randomizeSeed`
// checkbox, and internal `currentId` for server-driven prev/next navigation.
// Every other piece of state (pending delete, selection, etc.) stays on the
// Gallery page.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Download, Trash2,
  Image as ImageIcon, Music, Sparkles,
  AlertCircle, ChevronLeft, ChevronRight, SlidersHorizontal,
  Layers, HelpCircle, MoreVertical,
} from 'lucide-react';
import GalleryDetailsModal from './GalleryDetailsModal';
import type { GalleryItem } from '../../types';
import { api, buildDownloadUrl } from '../../services/comfyui';
import { useApp } from '../../context/AppContext';
import { isThreeDFilename } from '../../lib/media';
import { Checkbox } from '../ui/checkbox';
import AppModal from './AppModal';
import { Button } from '../ui/button';
import { ButtonGroup } from '../ui/button-group';
import { Spinner } from '../ui/spinner';
import ThreeDViewer from '../viewers/ThreeDViewer';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '../ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
} from '../ui/dropdown-menu';

interface Props {
  item: GalleryItem;
  onClose: () => void;
  onDelete: () => void;
  /** Fired after a successful regenerate. The promptId is the fresh prompt. */
  onRegenerated?: (newPromptId: string) => void;
  /** Current gallery filter — forwarded to GET /gallery/:id so prev/next
   *  neighbours are computed within the same filtered+sorted view. */
  filter?: { mediaType?: string; sort?: 'newest' | 'oldest'; favorite?: boolean };
}

export default function GalleryDetailModal({
  item, onClose, onDelete, onRegenerated, filter,
}: Props): JSX.Element {
  const { connected } = useApp();
  const [randomizeSeed, setRandomizeSeed] = useState<boolean>(true);
  const [regenerating, setRegenerating] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState<boolean>(false);

  // Internal nav: start from parent-provided item; chevrons update this.
  const [currentId, setCurrentId] = useState<string>(item.id);

  // Reset to parent item whenever the modal is opened for a new item.
  useEffect(() => {
    setCurrentId(item.id);
  }, [item.id]);

  // Wave P: the list endpoint returns slim rows (no `workflowJson` / prompt /
  // KSampler fields). Fetch the full row on open so the metadata panel +
  // regenerate button resolve, falling back to the slim props while the
  // request is in flight — the modal still opens instantly.
  const [detail, setDetail] = useState<GalleryItem>(item);
  // Loading flag for the brief detail fetch on prev/next navigation. Skipped
  // on initial open (the parent already handed us the slim row to display).
  const [navLoading, setNavLoading] = useState<boolean>(false);
  useEffect(() => {
    let cancelled = false;
    // When navigating to a new id via prev/next, we only have the id — no
    // slim row to fall back to. Use the current detail as a placeholder so
    // the modal doesn't blank mid-nav.
    if (currentId === item.id) {
      setDetail(item);
      setNavLoading(false);
    } else {
      setNavLoading(true);
    }
    void (async () => {
      try {
        const full = await api.getGalleryItem(currentId, filter ?? {});
        if (!cancelled) setDetail(full);
      } catch {
        // Leave `detail` at the slim fallback; the metadata panel gracefully
        // handles missing fields with its "No metadata captured" empty state.
      } finally {
        if (!cancelled) setNavLoading(false);
      }
    })();
    return () => { cancelled = true; };
  // currentId is the primary driver; filter is a stable object from parent.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId]);

  // Regenerate needs the stored workflow AND a reachable ComfyUI. Studio's
  // generate button uses the same `connected` gate (see Studio.tsx:351).
  const canRegenerate = Boolean(detail.workflowDetail) && connected;
  const regenerateTooltip = !detail.workflowDetail
    ? 'Import from ComfyUI to enable'
    : !connected
      ? 'ComfyUI is not connected'
      : '';

  // Arrow-key navigation between gallery items. Skipped while
  // regenerating so a stray keypress can't yank the user off the row mid
  // operation. Bound on window so the keys still fire if focus is on the
  // metadata text rather than a focusable button.
  useEffect(() => {
    if (regenerating) return;
    if (!detail.prevId && !detail.nextId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'ArrowLeft' && detail.prevId) { e.preventDefault(); setCurrentId(detail.prevId); }
      else if (e.key === 'ArrowRight' && detail.nextId) { e.preventDefault(); setCurrentId(detail.nextId); }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [detail.prevId, detail.nextId, regenerating]);

  const handleRegenerate = useCallback(async () => {
    if (!canRegenerate || regenerating) return;
    setError(null);
    setRegenerating(true);
    try {
      const res = await api.regenerateGalleryItem(detail.id, randomizeSeed);
      toast.success('Regenerate queued', {
        description: `Prompt ${res.promptId.slice(0, 8)}… — new output will appear in the gallery when ComfyUI finishes.`,
      });
      onRegenerated?.(res.promptId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Regenerate failed';
      setError(msg);
      toast.error('Regenerate failed', { description: msg });
    } finally {
      setRegenerating(false);
    }
  }, [canRegenerate, regenerating, detail.id, randomizeSeed, onRegenerated]);

  // Source label for the subtitle row.
  const sourceLabel = detail.templateName ?? null;
  // Prompt preview for the tooltip (truncated to 200 chars).
  const promptText = detail.workflowDetail?.promptText ?? null;
  const promptPreview = promptText
    ? (promptText.length > 200 ? promptText.slice(0, 200) + ' ...' : promptText)
    : null;

  const downloadUrl = buildDownloadUrl({
    filename: detail.filename,
    subfolder: detail.subfolder,
    type: detail.type ?? 'output',
  });

  const hasPrev = !!detail.prevId;
  const hasNext = !!detail.nextId;

  return (
    <>
    <AppModal
      open={true}
      onClose={onClose}
      title={detail.filename}
      subtitle={
        <span className="inline-flex items-center gap-1.5">
          <Layers className="h-3.5 w-3.5 shrink-0" />
          {sourceLabel ? (
            <a
              href={`/studio/${encodeURIComponent(sourceLabel)}`}
              className="text-primary hover:underline font-mono"
            >
              {sourceLabel}
            </a>
          ) : (
            <span>—</span>
          )}
          {promptPreview && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" className="inline-flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors">
                  <HelpCircle className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <span className="whitespace-pre-wrap break-words text-xs max-w-xs block">{promptPreview}</span>
              </TooltipContent>
            </Tooltip>
          )}
        </span>
      }
      size="lg"
      disableClose={regenerating}
      footer={
        <>
          <label
            className={`flex items-center gap-2 text-[11px] text-foreground select-none ${
              canRegenerate ? 'cursor-pointer' : 'opacity-50 cursor-not-allowed'
            }`}
            title={regenerateTooltip}
          >
            <Checkbox
              checked={randomizeSeed}
              onCheckedChange={(v) => setRandomizeSeed(v === true)}
              disabled={!canRegenerate || regenerating}
            />
            Randomize seed
          </label>

          {/* Desktop button group — hidden on mobile */}
          <div className="hidden sm:inline-flex gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setShowDetails(true)}
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              Details
            </Button>
            <ButtonGroup>
              <Button asChild variant="secondary">
                <a href={downloadUrl} download={detail.filename}>
                  <Download className="w-3.5 h-3.5" />
                  Download
                </a>
              </Button>
              <Button
                type="button"
                onClick={handleRegenerate}
                disabled={!canRegenerate || regenerating}
                title={regenerateTooltip}
              >
                {regenerating
                  ? <Spinner size="sm" />
                  : <Sparkles className="w-3.5 h-3.5" />}
                {regenerating ? 'Queuing…' : 'Regenerate'}
              </Button>
              <Button
                type="button"
                variant="secondary"
                className="text-destructive border-destructive/30 hover:bg-destructive/10"
                onClick={onDelete}
                disabled={regenerating}
              >
                <Trash2 className="w-3.5 h-3.5" />
                Delete
              </Button>
            </ButtonGroup>
          </div>

          {/* Mobile dropdown — visible only on small screens. `modal={false}`
              avoids Radix's focus-trap conflict with the surrounding AppModal
              (which already manages focus); without it the menu opens and
              closes in the same tick. */}
          <div className="sm:hidden inline-flex">
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger
                type="button"
                aria-label="Actions"
                className="btn btn-secondary btn-icon-pad"
              >
                <MoreVertical className="w-4 h-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="z-[60]">
                <DropdownMenuItem onSelect={() => setShowDetails(true)}>
                  <SlidersHorizontal />
                  Details
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <a href={downloadUrl} download={detail.filename}>
                    <Download />
                    Download
                  </a>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => { void handleRegenerate(); }}
                  data-disabled={!canRegenerate || regenerating}
                >
                  <Sparkles />
                  Regenerate
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={onDelete}
                  data-disabled={regenerating}
                >
                  <Trash2 />
                  Delete
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuCheckboxItem
                  checked={randomizeSeed}
                  onCheckedChange={(v) => setRandomizeSeed(v === true)}
                  data-disabled={!canRegenerate || regenerating}
                >
                  Randomize seed
                </DropdownMenuCheckboxItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </>
      }
    >
      <div className="space-y-4">
        {/* Media viewer with optional prev/next overlay buttons. Chevrons are
            driven by server-returned prevId/nextId so they walk the full
            filtered gallery, not just the current page. */}
        <div className="relative">
          <MediaViewer item={detail} />
          {navLoading && (
            <div
              className="absolute inset-0 flex items-center justify-center bg-background/60 backdrop-blur-sm rounded-lg pointer-events-none"
              aria-live="polite"
              aria-label="Loading"
            >
              <Spinner size="md" />
            </div>
          )}
          {hasPrev && (
            <button
              type="button"
              onClick={() => setCurrentId(detail.prevId!)}
              aria-label="Previous item"
              className="absolute left-2 top-1/2 -translate-y-1/2 inline-flex h-9 w-9 items-center justify-center rounded-full border bg-card/80 backdrop-blur-sm text-foreground shadow-sm hover:bg-card cursor-pointer transition-colors"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          )}
          {hasNext && (
            <button
              type="button"
              onClick={() => setCurrentId(detail.nextId!)}
              aria-label="Next item"
              className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex h-9 w-9 items-center justify-center rounded-full border bg-card/80 backdrop-blur-sm text-foreground shadow-sm hover:bg-card cursor-pointer transition-colors"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          )}
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-md bg-destructive/10 border border-destructive/30 px-3 py-2 text-xs text-destructive">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
      </div>
    </AppModal>
    {showDetails && (
      <GalleryDetailsModal item={detail} onClose={() => setShowDetails(false)} />
    )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Media viewer — mirrors the per-mediaType rendering that was inline on the
// old modal. Kept local to this component so the tile grid can keep its
// own thumbnail rendering without sharing state.

// Build the thumbnail URL for a gallery item by its id. The unified
// thumbnail service resolves the id to a file path and dispatches to the
// right pipeline (sharp for images, ffmpeg for video/audio).
function thumbnailUrl(item: GalleryItem): string {
  return `/api/thumbnail/${encodeURIComponent(item.id)}?w=640`;
}

function MediaViewer({ item }: { item: GalleryItem }): JSX.Element {
  return (
    <div className="bg-muted rounded-lg flex items-center justify-center overflow-hidden">
      {(() => {
        if (!item.url) return <ImageIcon className="w-16 h-16 text-muted-foreground" />;
        if (item.mediaType === 'video') {
          // Use the thumbnail as poster so the first frame is visible instantly
          // without loading the full video; the video itself streams on play.
          return (
            <video
              src={item.url}
              poster={thumbnailUrl(item)}
              controls
              className="max-h-[60vh] w-full"
            />
          );
        }
        if (item.mediaType === 'audio') {
          return <AudioViewer item={item} />;
        }
        // 3D assets (.glb/.gltf/...) are classified upstream as mediaType=image
        // so they live alongside images in the gallery; the actual renderer
        // needs to be <model-viewer>, not <img>.
        if (isThreeDFilename(item.filename)) {
          return (
            <div className="w-full h-[60vh] rounded-lg overflow-hidden">
              <ThreeDViewer src={item.url} alt={item.filename} />
            </div>
          );
        }
        // Use the thumbnail instead of the full file for the preview. The
        // thumbnail service serves a cached, resized WebP — much faster for
        // large outputs (e.g. 36 MB webp). Full file still available via Download.
        return (
          <img
            src={thumbnailUrl(item)}
            alt={item.filename}
            className="max-h-[60vh] w-full object-contain"
          />
        );
      })()}
    </div>
  );
}

// Audio viewer — wide banner cover (21:9) from the thumbnail service with
// the audio player overlaid on a gradient strip at the bottom. Cover falls
// back to the Music icon when the thumbnail request 404s.
function AudioViewer({ item }: { item: GalleryItem }): JSX.Element {
  const [coverError, setCoverError] = useState(false);
  const coverUrl = `/api/thumbnail/${encodeURIComponent(item.id)}?w=640`;
  return (
    <div className="relative w-full aspect-[21/9] rounded-lg overflow-hidden bg-muted">
      {coverError ? (
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-muted to-secondary">
          <Music className="w-16 h-16 text-muted-foreground" />
        </div>
      ) : (
        <img
          src={coverUrl}
          alt={item.filename}
          className="absolute inset-0 w-full h-full object-cover"
          onError={() => setCoverError(true)}
        />
      )}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/50 to-transparent p-3 pt-8">
        <audio src={item.url} controls className="w-full" />
      </div>
    </div>
  );
}
