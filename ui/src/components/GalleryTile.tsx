// Gallery tile with per-media-type rendering. The outer wrapper (grid cell,
// selection + favorite overlays, footer) is shared; the inner "preview area"
// swaps between image / video / audio.
//
// Fallbacks per type:
//  - image: `item.url` routed through the `/api/img` proxy (md5 disk cache)
//    at tile width so the browser never pulls the full-res original just to
//    paint a 320×180 thumb. Same-origin `/api/view?...` URLs pass through
//    unchanged; the proxy fetches them directly off disk.
//  - video: a cached webp poster from `/api/gallery/thumbnail?...`. On hover
//    the tile lazily swaps in a real video element (preload="none" until
//    hover, muted + looped) so the MP4 bytes only stream when the user is
//    actually previewing. On leave / scroll-away the video pauses to free
//    the decoder.
//  - audio: compact Play/Pause button + the <audio> element; no waveform
//    (punted — rendering needs upstream audio decoding). A Music icon sits
//    at the top of the tile so scanning a grid still reads as "audio".

import { useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import {
  Check, Star, StarOff,
  Image as ImageIcon, Video, Music,
  Play, Pause, Trash2,
} from 'lucide-react';
import type { GalleryItem } from '../types';
import { imgProxy } from '../lib/imgProxy';

const TILE_WIDTH = 320;

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
        className="block w-full aspect-square overflow-hidden"
      >
        <MediaPreview item={item} />
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
  return <ImagePreview item={item} />;
}

function ImagePreview({ item }: { item: GalleryItem }) {
  if (!item.url) return <ImageIcon className="w-10 h-10 text-slate-300" />;
  // Wave P: route the tile thumbnail through the `/api/img` proxy so the
  // browser receives a resized webp instead of the full-res original. The
  // proxy short-circuits same-origin paths (see `lib/imgProxy.ts`) and the
  // server handles the on-disk fetch via `/api/view`.
  const src = imgProxy(item.url, TILE_WIDTH) ?? item.url;
  return (
    <img
      src={src}
      alt={item.filename}
      className="w-full h-full object-cover"
      loading="lazy"
    />
  );
}

/** Build the `/api/gallery/thumbnail` URL for a given video row. */
function buildThumbUrl(item: GalleryItem): string {
  const params = new URLSearchParams();
  params.set('filename', item.filename);
  if (item.subfolder) params.set('subfolder', item.subfolder);
  if (item.type) params.set('type', item.type);
  params.set('w', String(TILE_WIDTH));
  return `/api/gallery/thumbnail?${params.toString()}`;
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

  const thumbUrl = buildThumbUrl(item);

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
      <div className="absolute bottom-1 left-1 badge-pill bg-black/60 text-white border-transparent text-[10px] px-1.5 py-0.5">
        <Video className="w-3 h-3" />
        Video
      </div>
    </div>
  );
}

function AudioPreview({ item }: { item: GalleryItem }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);

  const togglePlay = (e: ReactMouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const el = audioRef.current;
    if (!el) return;
    if (playing) {
      el.pause();
      setPlaying(false);
    } else {
      el.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    }
  };

  return (
    <div className="w-full h-full flex flex-col items-center justify-center gap-3 bg-gradient-to-br from-slate-50 to-slate-200 px-3">
      <Music className="w-10 h-10 text-slate-400" />
      {item.url ? (
        <>
          <button
            onClick={togglePlay}
            className="w-10 h-10 rounded-full bg-teal-600 hover:bg-teal-700 text-white flex items-center justify-center shadow-sm transition-colors"
            aria-label={playing ? 'Pause' : 'Play'}
          >
            {playing
              ? <Pause className="w-4 h-4" fill="currentColor" />
              : <Play className="w-4 h-4" fill="currentColor" />}
          </button>
          <audio
            ref={audioRef}
            src={item.url}
            preload="none"
            onEnded={() => setPlaying(false)}
            onPause={() => setPlaying(false)}
            onPlay={() => setPlaying(true)}
          />
        </>
      ) : null}
    </div>
  );
}
