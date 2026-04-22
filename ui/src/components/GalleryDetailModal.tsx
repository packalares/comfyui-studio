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
  Loader2, AlertCircle,
} from 'lucide-react';
import type { GalleryItem } from '../types';
import { api } from '../services/comfyui';
import { useApp } from '../context/AppContext';
import { isThreeDFilename } from '../lib/media';
import { Checkbox } from './ui/checkbox';
import AppModal from './AppModal';
import ThreeDViewer from './ThreeDViewer';

interface Props {
  item: GalleryItem;
  onClose: () => void;
  onDelete: () => void;
  /** Fired after a successful regenerate. The promptId is the fresh prompt. */
  onRegenerated?: (newPromptId: string) => void;
}

export default function GalleryDetailModal({
  item, onClose, onDelete, onRegenerated,
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
      size="md"
      disableClose={regenerating}
      footer={
        <>
          <label
            className={`flex items-center gap-2 text-[11px] text-slate-600 select-none ${
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
          <div className="btn-group">
            <a
              href={detail.url || '#'}
              download={detail.filename}
              className="btn-secondary"
            >
              <Download className="w-3.5 h-3.5" />
              Download
            </a>
            <button
              type="button"
              className="btn-primary"
              onClick={handleRegenerate}
              disabled={!canRegenerate || regenerating}
              title={regenerateTooltip}
            >
              {regenerating
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Sparkles className="w-3.5 h-3.5" />}
              {regenerating ? 'Queuing…' : 'Regenerate'}
            </button>
            <button
              type="button"
              className="btn-secondary text-red-600 border-red-200 hover:bg-red-50"
              onClick={onDelete}
              disabled={regenerating}
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete
            </button>
          </div>
        </>
      }
    >
      <div className="space-y-4">
        {/* Media viewer */}
        <MediaViewer item={detail} />

        {/* Metadata grid */}
        <MetadataSection item={detail} />

        {error && (
          <div className="flex items-start gap-2 rounded-md bg-rose-50 border border-rose-100 px-3 py-2 text-xs text-rose-700">
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
    <div className="bg-slate-100 rounded-lg flex items-center justify-center overflow-hidden">
      {(() => {
        if (!item.url) return <ImageIcon className="w-16 h-16 text-slate-300" />;
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
    <div className="relative w-full aspect-[21/9] rounded-lg overflow-hidden bg-slate-200">
      {coverError ? (
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-slate-50 to-slate-200">
          <Music className="w-16 h-16 text-slate-300" />
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
      <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-3 py-3 text-[11px] text-slate-500">
        No generation metadata was captured for this item. Regenerate is
        unavailable until you re-import from ComfyUI.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        Generation details
      </div>
      <dl className="divide-y divide-slate-100">
        {rows.map((r) => (
          <div key={r.label} className="grid grid-cols-[140px_1fr] gap-2 px-3 py-2 text-xs">
            <dt className="text-slate-500">{r.label}</dt>
            <dd
              className={
                (r.mono ? 'font-mono ' : '') +
                (r.multiline ? 'whitespace-pre-wrap break-words ' : 'truncate ') +
                'text-slate-800'
              }
              title={r.value ?? ''}
            >
              {r.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
