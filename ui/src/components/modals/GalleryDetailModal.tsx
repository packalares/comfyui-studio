// Detail modal for a single gallery item. Wave F redesign:
// - Visual language matches `ImportWorkflowModal` (panel shell, panel-header
//   row, panel-footer button strip).
// - Shows full metadata (prompt, seed, model, sampler, steps, cfg,
//   dimensions, template) captured from ComfyUI history at execution time.
// - Download + Delete preserved. Regenerate is new and disables with a
//   tooltip when the row has no stored workflow (pre-Wave-F imports).
//
// The modal owns the `regenerating` spinner state and the
// `randomizeSeed` checkbox; every other piece of state (pending delete,
// selection, etc.) stays on the Gallery page.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Download, Trash2,
  Image as ImageIcon, Music, Sparkles,
  AlertCircle, ChevronLeft, ChevronRight,
} from 'lucide-react';
import type { GalleryItem } from '../../types';
import { api } from '../../services/comfyui';
import { useApp } from '../../context/AppContext';
import { isThreeDFilename } from '../../lib/media';
import { Checkbox } from '../ui/checkbox';
import AppModal from './AppModal';
import { Button } from '../ui/button';
import { Spinner } from '../ui/spinner';
import ThreeDViewer from '../viewers/ThreeDViewer';

interface Props {
  item: GalleryItem;
  onClose: () => void;
  onDelete: () => void;
  /** Fired after a successful regenerate. The promptId is the fresh prompt. */
  onRegenerated?: (newPromptId: string) => void;
  /** Lightbox navigation — when provided, renders chevron buttons over the
   *  media viewer and binds Arrow Left / Right. The parent decides what
   *  "previous" and "next" mean (typically: previous/next id in the
   *  currently-filtered gallery list). */
  onPrev?: () => void;
  onNext?: () => void;
}

export default function GalleryDetailModal({
  item, onClose, onDelete, onRegenerated, onPrev, onNext,
}: Props): JSX.Element {
  const { connected } = useApp();
  const [randomizeSeed, setRandomizeSeed] = useState<boolean>(false);
  const [regenerating, setRegenerating] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Wave P: the list endpoint returns slim rows (no `workflowJson` / prompt /
  // KSampler fields). Fetch the full row on open so the metadata panel +
  // regenerate button resolve, falling back to the slim props while the
  // request is in flight — the modal still opens instantly.
  const [detail, setDetail] = useState<GalleryItem>(item);
  useEffect(() => {
    let cancelled = false;
    // Keep the slim fields visible immediately; only swap in the richer row
    // once the server responds so prompt/seed/etc. fill in without flicker.
    setDetail(item);
    void (async () => {
      try {
        const full = await api.getGalleryItem(item.id);
        if (!cancelled) setDetail(full);
      } catch {
        // Leave `detail` at the slim fallback; the metadata panel gracefully
        // handles missing fields with its "No metadata captured" empty state.
      }
    })();
    return () => { cancelled = true; };
    // Deps intentionally narrow: the parent re-emits new `item` object
    // identities whenever a WS `gallery` broadcast lands. Keeping `item`
    // in the deps refetched on every broadcast, flickering the metadata
    // panel. `item.id` is the only part that drives the refetch.
  }, [item.id]);

  // Regenerate needs the stored workflow AND a reachable ComfyUI. Studio's
  // generate button uses the same `connected` gate (see Studio.tsx:351).
  const canRegenerate = Boolean(detail.workflowJson) && connected;
  const regenerateTooltip = !detail.workflowJson
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
    if (!onPrev && !onNext) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'ArrowLeft' && onPrev) { e.preventDefault(); onPrev(); }
      else if (e.key === 'ArrowRight' && onNext) { e.preventDefault(); onNext(); }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [onPrev, onNext, regenerating]);

  const handleRegenerate = useCallback(async () => {
    if (!canRegenerate || regenerating) return;
    setError(null);
    setRegenerating(true);
    try {
      const res = await api.regenerateGalleryItem(item.id, randomizeSeed);
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
  }, [canRegenerate, regenerating, item.id, randomizeSeed, onRegenerated]);

  return (
    <AppModal
      open={true}
      onClose={onClose}
      title={detail.filename}
      subtitle={`${detail.mediaType}${detail.templateName ? ` · ${detail.templateName}` : ''}`}
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
          <div className="inline-flex gap-2">
            <Button asChild variant="secondary">
              <a href={detail.url || '#'} download={detail.filename}>
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
          </div>
        </>
      }
    >
      <div className="space-y-4">
        {/* Media viewer with optional prev/next overlay buttons. Buttons
            are absolute-positioned over the viewer's left/right edges and
            rendered only when the parent supplied a handler — so at the
            ends of the gallery the corresponding side hides automatically. */}
        <div className="relative">
          <MediaViewer item={detail} />
          {onPrev && (
            <button
              type="button"
              onClick={onPrev}
              aria-label="Previous item"
              className="absolute left-2 top-1/2 -translate-y-1/2 inline-flex h-9 w-9 items-center justify-center rounded-full border bg-card/80 backdrop-blur-sm text-foreground shadow-sm hover:bg-card cursor-pointer transition-colors"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          )}
          {onNext && (
            <button
              type="button"
              onClick={onNext}
              aria-label="Next item"
              className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex h-9 w-9 items-center justify-center rounded-full border bg-card/80 backdrop-blur-sm text-foreground shadow-sm hover:bg-card cursor-pointer transition-colors"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Metadata grid */}
        <MetadataSection item={detail} />

        {error && (
          <div className="flex items-start gap-2 rounded-md bg-destructive/10 border border-destructive/30 px-3 py-2 text-xs text-destructive">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
      </div>
    </AppModal>
  );
}

// ---------------------------------------------------------------------------
// Media viewer — mirrors the per-mediaType rendering that was inline on the
// old modal. Kept local to this component so the tile grid can keep its
// own thumbnail rendering without sharing state.

function MediaViewer({ item }: { item: GalleryItem }): JSX.Element {
  return (
    <div className="bg-muted rounded-lg flex items-center justify-center overflow-hidden">
      {(() => {
        if (!item.url) return <ImageIcon className="w-16 h-16 text-muted-foreground" />;
        if (item.mediaType === 'video') {
          return <video src={item.url} controls className="max-h-[60vh] w-full" />;
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
        return (
          <img
            src={item.url}
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

// ---------------------------------------------------------------------------
// Metadata panel — two-column key/value list. Hides rows with null/empty
// values; uses mono font for filenames/seeds.

interface MetadataRow {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
  multiline?: boolean;
}

function formatDuration(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

// Multi-entry model lists go through a single row with `\n` separators so the
// modal's existing multiline rendering handles them without a new layout type.
function formatModels(models: string[] | null | undefined, fallback: string | null | undefined): string | null {
  if (Array.isArray(models) && models.length > 0) {
    return models.length === 1 ? models[0]! : models.join('\n');
  }
  return fallback ?? null;
}

function MetadataSection({ item }: { item: GalleryItem }): JSX.Element | null {
  const dimensions = item.width && item.height
    ? `${item.width} × ${item.height}` : null;
  const modelsValue = formatModels(item.models, item.model);
  const multiModel = Array.isArray(item.models) && item.models.length > 1;
  const rows: MetadataRow[] = [
    { label: 'Prompt', value: item.promptText, multiline: true },
    { label: 'Negative prompt', value: item.negativeText || null, multiline: true },
    { label: multiModel ? 'Models' : 'Model', value: modelsValue, mono: true, multiline: multiModel },
    { label: 'Seed', value: item.seed != null ? String(item.seed) : null, mono: true },
    { label: 'Sampler', value: item.sampler, mono: true },
    { label: 'Scheduler', value: item.scheduler, mono: true },
    { label: 'Steps', value: item.steps != null ? String(item.steps) : null },
    { label: 'CFG', value: item.cfg != null ? String(item.cfg) : null },
    { label: 'Denoise', value: item.denoise != null ? String(item.denoise) : null },
    { label: 'Batch size', value: item.batchSize != null ? String(item.batchSize) : null },
    { label: 'Dimensions', value: dimensions },
    { label: 'Length', value: item.lengthFrames != null ? String(item.lengthFrames) : null },
    { label: 'FPS', value: item.fps != null ? String(item.fps) : null },
    { label: 'Duration', value: formatDuration(item.durationMs) },
    { label: 'Template', value: item.templateName },
  ].filter((r) => r.value != null && r.value !== '');

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed bg-muted px-3 py-3 text-[11px] text-muted-foreground">
        No generation metadata was captured for this item. Regenerate is
        unavailable until you re-import from ComfyUI.
      </div>
    );
  }

  // Two layout buckets:
  //  - Wide rows (Prompt, Negative prompt, multi-Models) render first as
  //    title-less text blocks — the section header above already gives
  //    them context, and prompt text is the main read so a label column
  //    just steals visual weight.
  //  - Compact rows (seed, sampler, steps, etc.) render in a 2-column
  //    grid with label-above-value cells so short numeric fields don't
  //    waste a full row each.
  const wideRows = rows.filter((r) => r.multiline);
  const compactRows = rows.filter((r) => !r.multiline);

  return (
    <div className="rounded-lg border bg-card">
      <div className="border-b px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Generation details
      </div>
      {wideRows.length > 0 && (
        <div className="divide-y divide-border">
          {wideRows.map((r) => (
            <div
              key={r.label}
              className={
                'px-3 py-2 text-xs text-foreground whitespace-pre-wrap break-words '
                + (r.mono ? 'font-mono ' : '')
              }
              title={r.value ?? ''}
            >
              {r.value}
            </div>
          ))}
        </div>
      )}
      {compactRows.length > 0 && (
        <dl
          className={
            'grid grid-cols-2 gap-x-3 gap-y-2 px-3 py-2 text-xs '
            + (wideRows.length > 0 ? 'border-t' : '')
          }
        >
          {compactRows.map((r) => (
            <div key={r.label} className="min-w-0">
              <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {r.label}
              </dt>
              <dd
                className={
                  'mt-0.5 truncate text-foreground '
                  + (r.mono ? 'font-mono ' : '')
                }
                title={r.value ?? ''}
              >
                {r.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
