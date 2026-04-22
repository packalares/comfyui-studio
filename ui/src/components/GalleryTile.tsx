// Gallery tile with per-media-type rendering. The outer wrapper (grid cell,
// selection + favorite overlays, footer) is shared; the inner "preview area"
// swaps between image / video / audio.
//
// All media types now flow through `/api/thumbnail/:id?w=...` — the unified
// thumbnail service picks the correct pipeline (sharp for images, ffmpeg
// frame-grab for video, ffmpeg coverart + Pexels fallback for audio,
// static SVG for 3D) from the DB row's filename extension. Video tiles
// still lazily swap in a `<video>` element on hover (preload="none" until
// hover, muted + looped) so MP4 bytes only stream when previewing; on
// leave / scroll-away the video pauses to free the decoder.

import { useEffect, useRef, useState } from 'react';
import {
  Check, Star, StarOff,
  Image as ImageIcon, Video, Music,
  Play, Trash2, Box, Clock,
} from 'lucide-react';
import type { GalleryItem } from '../types';
import { isThreeDFilename } from '../lib/media';

const TILE_WIDTH = 320;

// Unified thumbnail URL for a gallery row. The server resolves the id to
// a filename + subfolder + type and dispatches to the right pipeline.
function thumbUrlForItem(item: GalleryItem): string {
  return `/api/thumbnail/${encodeURIComponent(item.id)}?w=${TILE_WIDTH}`;
}

// Format milliseconds as m:ss (or h:mm:ss for >1h). Returns null when the
// input is missing so callers can skip rendering the duration pill.
function formatDuration(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return null;
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Type badge — one visual language for every media type. Rendered bottom-
// left on the tile; duration pill (when available) sits to its right.
function TypeBadge({ icon: Icon, label }: { icon: typeof Video; label: string }) {
  return (
    <div className="badge-pill bg-black/60 text-white border-transparent text-[10px] px-1.5 py-0.5">
      <Icon className="w-3 h-3" />
      {label}
    </div>
  );
}

function DurationBadge({ ms }: { ms: number | null | undefined }) {
  const text = formatDuration(ms);
  if (!text) return null;
  return (
    <div className="badge-pill bg-black/60 text-white border-transparent text-[10px] px-1.5 py-0.5">
      <Clock className="w-3 h-3" />
      {text}
    </div>
  );
}

interface GalleryTileProps {
  item: GalleryItem;
  isSelected: boolean;
  isFav: boolean;
  onOpen: () => void;
  onToggleSelect: () => void;
  onToggleFavorite: () => void;
  onDelete: () => void;
}

export default function GalleryTile({
  item, isSelected, isFav,
  onOpen, onToggleSelect, onToggleFavorite, onDelete,
}: GalleryTileProps) {
  return (
    <div
      className={`group relative overflow-hidden rounded-xl bg-slate-100 ring-1 ring-slate-200 shadow-sm transition-all hover:shadow-lg hover:-translate-y-0.5 ${
        isSelected ? 'ring-2 ring-teal-500' : ''
      }`}
    >
      <button
        onClick={onOpen}
        className="block w-full aspect-[4/3] overflow-hidden relative"
      >
        <MediaPreview item={item} />
        {/* Type + duration pills — bottom-left of the media area. One
            visual language across image / video / audio / 3D. */}
        <div className="absolute bottom-1 left-1 flex items-center gap-1 pointer-events-none">
          <MediaTypeBadge item={item} />
          <DurationBadge ms={item.durationMs} />
        </div>
      </button>

      {/* Hover dim + gradient so overlaid icons stay legible over bright media. */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-black/30 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"
      />

      {/* Selection checkbox */}
      <div className="absolute top-2 left-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={(e) => { e.stopPropagation(); onToggleSelect(); }}
          className={`p-1 rounded-full border backdrop-blur transition-colors ${
            isSelected
              ? 'bg-teal-500 border-teal-500 text-white'
              : 'bg-white/80 border-white/40 text-slate-700 hover:bg-white'
          }`}
          aria-label={isSelected ? 'Deselect' : 'Select'}
        >
          <Check className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Favorite + delete actions */}
      <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={(e) => { e.stopPropagation(); onToggleFavorite(); }}
          className="p-1 rounded-full border border-white/40 bg-white/80 text-slate-700 hover:text-yellow-500 backdrop-blur transition-colors"
          aria-label={isFav ? 'Unfavorite' : 'Favorite'}
        >
          {isFav
            ? <Star className="w-3.5 h-3.5 fill-yellow-400 text-yellow-400" />
            : <StarOff className="w-3.5 h-3.5" />}
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="p-1 rounded-full border border-white/40 bg-white/80 text-slate-700 hover:text-red-600 backdrop-blur transition-colors"
          aria-label="Delete"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Persistent favorite mark when starred (even without hover). */}
      {isFav && (
        <div className="absolute bottom-2 right-2 opacity-100 group-hover:opacity-0 transition-opacity pointer-events-none">
          <Star className="w-3.5 h-3.5 fill-yellow-400 text-yellow-400 drop-shadow" />
        </div>
      )}
    </div>
  );
}

/** Routes by `mediaType` to the correct preview component. */
function MediaPreview({ item }: { item: GalleryItem }) {
  if (item.mediaType === 'video') return <VideoPreview item={item} />;
  if (item.mediaType === 'audio') return <AudioPreview item={item} />;
  // 3D assets (.glb / .gltf / ...) are classified as `image` upstream so they
  // share the image filter bucket; the tile swaps in a cube-icon placeholder
  // instead of `<img>` (live WebGL in a grid of tiles would be wasteful).
  // The detail modal / Studio result panel mount the actual <model-viewer>.
  if (isThreeDFilename(item.filename)) return <ThreeDPreview />;
  return <ImagePreview item={item} />;
}

/** Picks the right TypeBadge based on the item. */
function MediaTypeBadge({ item }: { item: GalleryItem }) {
  if (item.mediaType === 'video') return <TypeBadge icon={Video} label="Video" />;
  if (item.mediaType === 'audio') return <TypeBadge icon={Music} label="Audio" />;
  if (isThreeDFilename(item.filename)) return <TypeBadge icon={Box} label="3D" />;
  return <TypeBadge icon={ImageIcon} label="Image" />;
}

function ThreeDPreview() {
  return (
    <div className="w-full h-full flex flex-col items-center justify-center gap-1 bg-gradient-to-br from-slate-100 to-slate-200">
      <Box className="w-10 h-10 text-slate-400" />
      <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">3D</span>
    </div>
  );
}

function ImagePreview({ item }: { item: GalleryItem }) {
  if (!item.url) return <ImageIcon className="w-10 h-10 text-slate-300" />;
  // All media types go through the unified /api/thumbnail/:id endpoint.
  return (
    <img
      src={thumbUrlForItem(item)}
      alt={item.filename}
      className="w-full h-full object-cover"
      loading="lazy"
    />
  );
}

function VideoPreview({ item }: { item: GalleryItem }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState(false);
  const [videoLoaded, setVideoLoaded] = useState(false);
  const [thumbError, setThumbError] = useState(false);

  // Pause the hover-preview whenever the tile scrolls out of view so we
  // aren't burning a decoder on off-screen rows.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting && videoRef.current) {
          videoRef.current.pause();
        }
      }
    }, { threshold: 0 });
    io.observe(container);
    return () => io.disconnect();
  }, []);

  if (!item.url) {
    return (
      <div className="w-full h-full bg-slate-800 flex items-center justify-center">
        <Play className="w-8 h-8 text-white/80" fill="currentColor" />
      </div>
    );
  }

  const startPreview = () => {
    setHover(true);
    setVideoLoaded(true);
    const el = videoRef.current;
    if (!el) return;
    // Lazy-assign src on first hover so the MP4 bytes don't flow until the
    // user actually requests a preview.
    if (!el.src) el.src = item.url ?? '';
    el.currentTime = 0;
    el.play().catch(() => { /* autoplay may be blocked; the poster stays. */ });
  };
  const endPreview = () => {
    setHover(false);
    const el = videoRef.current;
    if (!el) return;
    el.pause();
    el.currentTime = 0;
  };

  const thumbUrl = thumbUrlForItem(item);

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full"
      onMouseEnter={startPreview}
      onMouseLeave={endPreview}
      onTouchStart={startPreview}
      onTouchEnd={endPreview}
    >
      {!thumbError ? (
        <img
          src={thumbUrl}
          alt={item.filename}
          className={`w-full h-full object-cover ${hover && videoLoaded ? 'opacity-0' : 'opacity-100'} transition-opacity`}
          loading="lazy"
          onError={() => setThumbError(true)}
        />
      ) : (
        <div className={`w-full h-full bg-slate-800 flex items-center justify-center ${hover && videoLoaded ? 'opacity-0' : 'opacity-100'} transition-opacity`}>
          <Play className="w-8 h-8 text-white/80" fill="currentColor" />
        </div>
      )}
      <video
        ref={videoRef}
        className={`absolute inset-0 w-full h-full object-cover ${hover && videoLoaded ? 'opacity-100' : 'opacity-0'} transition-opacity`}
        muted
        loop
        playsInline
        preload="none"
      />
      {!hover && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/20 pointer-events-none">
          <div className="bg-black/60 rounded-full p-2">
            <Play className="w-5 h-5 text-white" fill="currentColor" />
          </div>
        </div>
      )}
      {/* Type badge lives on the outer tile — no per-component pill here. */}
    </div>
  );
}

// Static preview — the inline play button + <audio> element were removed.
// Audio playback belongs in the detail modal (which has a real
// <audio controls> player). Clicking the tile opens the modal.
//
// Cover image comes from the unified thumbnail service's audio waterfall:
// embedded cover art (ID3 APIC / FLAC PICTURE / MP4 covr) -> Pexels (if
// key configured) -> Picsum seeded per-file -> static Music SVG. On any
// failure we fall back locally to the Music icon so the tile never blanks.
function AudioPreview({ item }: { item: GalleryItem }) {
  const [error, setError] = useState(false);
  if (error) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-slate-50 to-slate-200">
        <Music className="w-10 h-10 text-slate-400" />
      </div>
    );
  }
  return (
    <img
      src={thumbUrlForItem(item)}
      alt={item.filename}
      className="w-full h-full object-cover"
      loading="lazy"
      onError={() => setError(true)}
    />
  );
}
