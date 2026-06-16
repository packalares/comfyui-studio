// Media library picker. Three-pane layout: source nav on the left (Local /
// External — only Local is wired today), a masonry grid in the middle
// scoped to the current source + kind, and an action panel on the right
// for upload / take-photo / record-video. Files come from ComfyUI's
// input/ directory via /api/media-library.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Upload, Trash2, Image as ImageIcon, Music, Film, AlertTriangle,
  Folder, Globe, Camera, Video, User, Play, Pause,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '../../services/comfyui';
import type { MediaLibraryItem } from '../../services/comfyui';
import { Spinner } from '../ui/spinner';
import { Button } from '../ui/button';
import { Tooltip, TooltipTrigger, TooltipContent } from '../ui/tooltip';
import AppModal from './AppModal';
import ConfirmDialog from './ConfirmDialog';

type MediaKind = 'image' | 'audio' | 'video';
type Source = 'local' | 'external';

const KIND_LABEL: Record<MediaKind, string> = {
  image: 'image',
  audio: 'audio',
  video: 'video',
};
const KIND_ACCEPT: Record<MediaKind, string> = {
  image: 'image/*',
  audio: 'audio/*',
  video: 'video/*',
};
const KIND_ICON: Record<MediaKind, React.ElementType> = {
  image: ImageIcon,
  audio: Music,
  video: Film,
};

interface Props {
  open: boolean;
  onClose: () => void;
  kind: MediaKind;
  onSelect: (item: MediaLibraryItem) => void;
}

export default function MediaLibraryModal({ open, onClose, kind, onSelect }: Props): JSX.Element {
  const [source, setSource] = useState<Source>('local');

  // Stop any playing audio when the modal closes.
  useEffect(() => {
    if (!open && activeAudioEl) {
      activeAudioEl.pause();
      activeAudioEl = null;
    }
  }, [open]);
  const [items, setItems] = useState<MediaLibraryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<MediaLibraryItem | null>(null);

  const refresh = useCallback(async () => {
    if (source !== 'local') { setItems([]); return; }
    setLoading(true);
    setError(null);
    try {
      const list = await api.listMediaLibrary(kind);
      setItems(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load library');
    } finally {
      setLoading(false);
    }
  }, [kind, source]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const handleUpload = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      let last: MediaLibraryItem | null = null;
      for (const f of Array.from(files)) {
        last = await api.uploadMediaLibrary(f, kind);
      }
      await refresh();
      if (last) {
        toast.success(`Uploaded ${files.length === 1 ? last.filename : `${files.length} files`}`);
        if (files.length === 1) {
          onSelect(last);
          onClose();
        }
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err instanceof Error ? err.message : 'Upload failed');
      toast.error('Upload failed', { description: msg });
    } finally {
      setUploading(false);
    }
  }, [kind, onSelect, onClose, refresh]);

  const handleConfirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    try {
      await api.deleteMediaLibrary(pendingDelete.filename, pendingDelete.subfolder);
      await refresh();
      toast.success(`Deleted ${pendingDelete.filename}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Delete failed';
      toast.error('Delete failed', { description: msg });
    } finally {
      setPendingDelete(null);
    }
  }, [pendingDelete, refresh]);

  const KindIcon = KIND_ICON[kind];

  return (
    <AppModal
      open={open}
      onClose={onClose}
      title={`Pick ${KIND_LABEL[kind] === 'audio' ? 'audio' : `a ${KIND_LABEL[kind]}`}`}
      icon={<KindIcon className="w-4 h-4" />}
      size="xl"
      className="max-w-[95vw]"
      scrollBody={false}
      closeOnBackdropClick
    >
      <div className="flex h-[80vh] -mx-4 -mb-4">
        {/* LEFT: source nav */}
        <aside className="w-44 shrink-0 border-r p-3 space-y-1">
          <p className="eyebrow mb-2 px-2">Source</p>
          <SourceItem
            icon={Folder}
            label="Local"
            active={source === 'local'}
            onClick={() => setSource('local')}
          />
          <SourceItem
            icon={User}
            label="Characters"
            disabled
            tooltip="Saved characters (coming soon)"
          />
          <SourceItem
            icon={Globe}
            label="External"
            disabled
            tooltip="Search stock libraries (coming soon)"
          />
        </aside>

        {/* MIDDLE: grid */}
        <main className="flex-1 overflow-y-auto p-4 scrollbar-subtle">
          {source === 'external' ? (
            <ExternalPlaceholder />
          ) : loading ? (
            <div className="flex items-center justify-center py-10">
              <Spinner size="md" />
            </div>
          ) : error ? (
            <div className="info-box flex items-center gap-2 border-warning/40 bg-warning/10">
              <AlertTriangle className="w-3.5 h-3.5 text-warning shrink-0" />
              <span className="text-warning">{error}</span>
            </div>
          ) : items.length === 0 ? (
            <EmptyState kind={kind} />
          ) : (
            <MasonryGrid
              items={items}
              onSelect={(item) => { onSelect(item); onClose(); }}
              onDelete={setPendingDelete}
            />
          )}
        </main>

        {/* RIGHT: upload + capture actions */}
        <aside className="w-56 shrink-0 border-l p-4">
          <UploadPanel
            kind={kind}
            uploading={uploading}
            onPick={handleUpload}
          />
        </aside>
      </div>

      {/* Delete confirmation — uses the shared ConfirmDialog so the design
          matches every other destructive flow (Gallery, Imports, etc.). */}
      <ConfirmDialog
        open={!!pendingDelete}
        onClose={() => setPendingDelete(null)}
        title="Delete file?"
        description={pendingDelete ? `Permanently delete ${pendingDelete.filename}?` : ''}
        confirmLabel="Delete"
        confirmTone="danger"
        onConfirm={handleConfirmDelete}
      />
    </AppModal>
  );
}

function SourceItem({
  icon: Icon, label, active, disabled, onClick, tooltip,
}: {
  icon: React.ElementType;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  tooltip?: string;
}) {
  const cls = `flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium transition-colors ${
    active
      ? 'bg-muted text-foreground'
      : disabled
        ? 'text-muted-foreground/60 cursor-not-allowed'
        : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
  }`;
  const btn = (
    <button type="button" disabled={disabled} onClick={onClick} className={cls}>
      <Icon className="h-4 w-4 shrink-0" />
      {label}
    </button>
  );
  if (!tooltip) return btn;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{btn}</TooltipTrigger>
      <TooltipContent side="right">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

function EmptyState({ kind }: { kind: MediaKind }) {
  const Icon = KIND_ICON[kind];
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <Icon className="h-5 w-5 text-muted-foreground" />
      </div>
      <p className="text-sm font-medium text-foreground">No {KIND_LABEL[kind]} files yet</p>
      <p className="text-xs text-muted-foreground mt-1 max-w-xs">
        Drop a file in the panel on the right, or click <span className="font-medium">Upload a file</span>.
      </p>
    </div>
  );
}

function ExternalPlaceholder() {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <Globe className="h-5 w-5 text-muted-foreground" />
      </div>
      <p className="text-sm font-medium text-foreground">External libraries coming soon</p>
      <p className="text-xs text-muted-foreground mt-1 max-w-xs">
        We'll wire open-source stock providers here so you can search free images and video without leaving Studio.
      </p>
    </div>
  );
}

function UploadPanel({
  kind, uploading, onPick,
}: {
  kind: MediaKind;
  uploading: boolean;
  onPick: (files: FileList | null) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        onPick(e.dataTransfer.files);
      }}
      className={`flex h-full flex-col gap-3 rounded-lg p-3 transition-colors ${
        dragOver ? 'bg-brand/5 ring-2 ring-brand ring-inset' : ''
      }`}
    >
      <p className="text-xs text-muted-foreground">
        Drop {KIND_LABEL[kind] === 'audio' ? 'an audio file' : `a ${KIND_LABEL[kind]}`} here or pick a source below.
      </p>
      <label className="block">
        <Button type="button" className="w-full" disabled={uploading} asChild>
          <span>
            {uploading ? <Spinner size="xs" /> : <Upload className="h-4 w-4" />}
            {uploading ? 'Uploading…' : 'Upload a file'}
          </span>
        </Button>
        <input
          type="file"
          accept={KIND_ACCEPT[kind]}
          multiple
          className="hidden"
          disabled={uploading}
          onChange={(e) => onPick(e.target.files)}
        />
      </label>
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button type="button" variant="outline" className="w-full" disabled>
              <Camera className="h-4 w-4" />
              Take photo
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>Coming soon</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button type="button" variant="outline" className="w-full" disabled>
              <Video className="h-4 w-4" />
              Record video
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>Coming soon</TooltipContent>
      </Tooltip>
    </div>
  );
}

// Module-level ref to the currently-playing audio element.
// Lets AudioTile instances stop each other without React context overhead.
let activeAudioEl: HTMLAudioElement | null = null;

function MasonryGrid({
  items, onSelect, onDelete,
}: {
  items: MediaLibraryItem[];
  onSelect: (item: MediaLibraryItem) => void;
  onDelete: (item: MediaLibraryItem) => void;
}) {
  // Image grids use CSS columns (masonry) because images have variable
  // heights and need to pack naturally. Audio grids use an auto-fill CSS
  // grid: every tile is a fixed-size square, so a regular grid fills the
  // available row width left-to-right instead of letting columns leave
  // empty whitespace on the right when the item count doesn't match the
  // column count. minmax(96px, 1fr) → tiles ~96-128 px depending on
  // container width; the grid grows additional columns as space allows.
  const allAudio = items.length > 0 && items.every((it) => it.kind === 'audio');
  if (allAudio) {
    return (
      <div className="grid gap-1.5 grid-cols-6">
        {items.map((it) => (
          <Tile
            key={`${it.subfolder}/${it.filename}`}
            item={it}
            onSelect={onSelect}
            onDelete={onDelete}
          />
        ))}
      </div>
    );
  }
  return (
    <div className="columns-2 sm:columns-3 md:columns-4 gap-1 [column-fill:_balance]">
      {items.map((it) => (
        <Tile
          key={`${it.subfolder}/${it.filename}`}
          item={it}
          onSelect={onSelect}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}

// Build the ComfyUI /api/view URL for a library item. Used by the audio tile
// (for the inline player) and the image tile (for the thumbnail). Audio
// streams the original; image gets the file as-is since ComfyUI handles
// content-type from the extension.
function viewUrl(item: MediaLibraryItem): string {
  const qs = new URLSearchParams({
    filename: item.filename,
    subfolder: item.subfolder,
    type: 'input',
  });
  return `/api/view?${qs.toString()}`;
}

// Pure dispatcher — no hooks here so the audio/non-audio branches each get
// a clean component scope and React's rules-of-hooks aren't violated.
function Tile({
  item, onSelect, onDelete,
}: {
  item: MediaLibraryItem;
  onSelect: (item: MediaLibraryItem) => void;
  onDelete: (item: MediaLibraryItem) => void;
}) {
  if (item.kind === 'audio') {
    return <AudioTile item={item} onSelect={onSelect} onDelete={onDelete} />;
  }
  return <VisualTile item={item} onSelect={onSelect} onDelete={onDelete} />;
}

// Image / video variant — kept as the original visual square with thumbnail
// (image) or icon-only placeholder (video) plus a hover delete pill.
function VisualTile({
  item, onSelect, onDelete,
}: {
  item: MediaLibraryItem;
  onSelect: (item: MediaLibraryItem) => void;
  onDelete: (item: MediaLibraryItem) => void;
}) {
  const previewUrl = useMemo(() => {
    if (item.kind !== 'image') return null;
    return viewUrl(item);
  }, [item]);

  const Icon = KIND_ICON[item.kind];

  return (
    <button
      type="button"
      onClick={() => onSelect(item)}
      className="group relative mb-1 block w-full overflow-hidden rounded-md bg-card break-inside-avoid"
    >
      {previewUrl ? (
        <img src={previewUrl} alt="" className="w-full h-auto block" />
      ) : (
        <div className="flex aspect-square flex-col items-center justify-center gap-1 bg-muted/40 text-muted-foreground">
          <Icon className="h-6 w-6" />
        </div>
      )}
      {/* Subtle darken-on-hover overlay so the action pill has contrast
          regardless of the image content underneath. */}
      <span className="pointer-events-none absolute inset-0 bg-foreground/0 group-hover:bg-foreground/15 transition-colors" />
      {/* Dark translucent disc, top-right — matches the 2.png reference. */}
      <span
        role="button"
        tabIndex={0}
        onClick={(e) => { e.stopPropagation(); onDelete(item); }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onDelete(item); } }}
        className="absolute right-1.5 top-1.5 inline-flex h-7 w-7 items-center justify-center rounded-lg bg-black/40 text-white backdrop-blur-sm opacity-0 transition-opacity group-hover:opacity-100 hover:bg-black/60 cursor-pointer"
        aria-label="Delete"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </span>
    </button>
  );
}

// Audio variant: square card with inline play/pause, seek bar, and a clean
// bottom filename strip. Uses module-level activeAudioEl so only one tile
// plays at a time across the whole grid.
function AudioTile({
  item, onSelect, onDelete,
}: {
  item: MediaLibraryItem;
  onSelect: (item: MediaLibraryItem) => void;
  onDelete: (item: MediaLibraryItem) => void;
}) {
  const url = useMemo(() => viewUrl(item), [item]);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const togglePlay = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      // Stop any other currently-playing tile first.
      if (activeAudioEl && activeAudioEl !== el) {
        activeAudioEl.pause();
      }
      activeAudioEl = el;
      void el.play();
    } else {
      el.pause();
    }
  }, []);

  // Cleanup on unmount: stop audio if this tile owns the active element.
  useEffect(() => {
    return () => {
      const el = audioRef.current;
      if (el && activeAudioEl === el) {
        el.pause();
        activeAudioEl = null;
      }
    };
  }, []);

  return (
    <div className="group relative mb-1 block aspect-square w-full break-inside-avoid overflow-hidden rounded-md bg-gradient-to-br from-muted via-muted/70 to-secondary/40">
      {/* The square card itself is the select target. */}
      <button
        type="button"
        onClick={() => onSelect(item)}
        aria-label={`Select ${item.filename}`}
        className="absolute inset-0 cursor-pointer"
      />

      {/* Top-left info — dark translucent disc, matches 2.png design. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="absolute left-1.5 top-1.5 z-10 inline-flex h-7 w-7 items-center justify-center rounded-lg bg-black/40 text-white backdrop-blur-sm cursor-help"
            aria-label="File info"
          >
            <Music className="h-3.5 w-3.5" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs">
          <span className="break-all text-xs">{item.filename}</span>
        </TooltipContent>
      </Tooltip>

      {/* Top-right delete — dark translucent disc, matches 2.png design. */}
      <span
        className="absolute right-1.5 top-1.5 z-10 inline-flex h-7 w-7 items-center justify-center rounded-lg bg-black/40 text-white backdrop-blur-sm opacity-0 transition-opacity group-hover:opacity-100 hover:bg-black/60 cursor-pointer"
        role="button"
        tabIndex={0}
        onClick={(e) => { e.stopPropagation(); onDelete(item); }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onDelete(item); } }}
        aria-label="Delete"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </span>

      {/* Center play / pause. Larger ring + medium shadow so it pops on
          top of the gradient background, matching the original look. */}
      <span className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => { e.stopPropagation(); togglePlay(); }}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePlay(); } }}
          aria-label={playing ? 'Pause' : 'Play'}
          className="pointer-events-auto inline-flex h-12 w-12 items-center justify-center rounded-full bg-background/90 text-foreground shadow-md ring-1 ring-border transition-transform hover:scale-105 cursor-pointer"
        >
          {playing ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5 translate-x-[1px]" />}
        </span>
      </span>

      {/* Seek bar — only shown while playing. Sits just above the filename
          gradient so the user can scrub without obscuring the play button. */}
      {playing && (
        <input
          type="range"
          min={0}
          max={duration || 1}
          step={0.01}
          value={currentTime}
          onChange={(e) => {
            const el = audioRef.current;
            if (el) el.currentTime = Number(e.target.value);
          }}
          onClick={(e) => e.stopPropagation()}
          className="absolute inset-x-2 bottom-9 z-20 h-1 w-[calc(100%-1rem)] cursor-pointer appearance-none rounded-full bg-foreground/20 [&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-background [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:border-0 [&::-webkit-slider-thumb]:shadow"
        />
      )}

      {/* Filename strip — gradient back at the bottom, matching the original. */}
      <span className="absolute inset-x-0 bottom-0 z-10 px-2 py-1.5 bg-gradient-to-t from-foreground/85 via-foreground/50 to-transparent pointer-events-none">
        <span className="block truncate text-[11px] font-medium text-background">
          {item.filename}
        </span>
      </span>

      <audio
        ref={audioRef}
        src={url}
        preload="none"
        onPlay={() => setPlaying(true)}
        onPause={() => {
          setPlaying(false);
          if (activeAudioEl === audioRef.current) activeAudioEl = null;
        }}
        onEnded={() => {
          setPlaying(false);
          if (activeAudioEl === audioRef.current) activeAudioEl = null;
        }}
        onTimeUpdate={() => {
          const el = audioRef.current;
          if (el) setCurrentTime(el.currentTime);
        }}
        onLoadedMetadata={() => {
          const el = audioRef.current;
          if (el) setDuration(el.duration);
        }}
        className="hidden"
      />
    </div>
  );
}
