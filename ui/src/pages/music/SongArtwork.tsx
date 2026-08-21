// Artwork for a song, in one place so the card / row / player bar can't drift.
//
// Songs are gallery rows (see `0009_ace_songs_gallery.ts`), so they get the
// same treatment as any other media in comfy: `/api/thumbnail/:id` resolves
// audio through a real pipeline — embedded cover art (ID3v2 APIC / FLAC
// PICTURE / MP4 covr via ffmpeg) -> Pexels keyed on the prompt text (if an API
// key is configured) -> Picsum (keyless, deterministic per seed) -> a static
// Music SVG. See `services/thumbnail/pipelines/audio.ts`.
//
// This replaced a locally-drawn seeded-palette placeholder (`AlbumCover`).
// That placeholder is KEPT as the last-resort fallback rather than deleted:
// the thumbnail endpoint can legitimately fail (row swept away, ffmpeg
// missing, thumbnail cache being rebuilt), and a music library rendering a
// grid of broken-image icons is a worse outcome than rendering the old
// generated art. `AlbumCover` is seeded by song id, so the fallback is stable
// per song rather than flickering between renders.

import { useState } from 'react';
import { AlbumCover } from './AlbumCover';
import type { Song } from '../../types/ace';

type Size = 'xs' | 'sm' | 'md' | 'full';

/** Requested thumbnail widths. The service rounds/caches per width, so keeping
 *  these to a small fixed set means a library scroll reuses cache entries
 *  instead of generating a new render per tile size. */
const WIDTH: Record<Size, number> = { xs: 64, sm: 96, md: 256, full: 512 };

interface Props {
  song: Song;
  size: Size;
  className?: string;
}

export function SongArtwork({ song, size, className }: Props): JSX.Element {
  // Reset on song change so a failed thumbnail doesn't permanently poison the
  // slot when the component is reused for a different song (the player bar
  // swaps `song` in place rather than remounting).
  const [failed, setFailed] = useState<string | null>(null);
  const broken = failed === song.id;

  // An explicit `coverUrl` wins: it's only ever set when something deliberately
  // assigned art to this song, which should outrank a derived thumbnail.
  const src = song.coverUrl || (song.galleryId
    ? `/api/thumbnail/${encodeURIComponent(song.galleryId)}?w=${WIDTH[size]}`
    : null);

  if (!src || broken) {
    return <AlbumCover seed={song.id} size={size} className={className} />;
  }

  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      className={className ?? 'h-full w-full object-cover'}
      onError={() => setFailed(song.id)}
    />
  );
}
