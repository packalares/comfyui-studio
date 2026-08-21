// Gallery tile for a song — Suno-style grid card (cover art, hover play
// button, title/style, duration). Sibling to `SongRow.tsx` (the list/row
// layout used on narrow viewports, inside playlists, and for search
// results); same props/actions, denser presentation for the Library grid
// and the Create tab's "recent" feed.
//
// Visual language mirrors `components/cards/GalleryTile.tsx` (the Gallery
// page's image/video tile) — translucent overlay action buttons, hover
// dim + lift, overlay badge for duration — so a song card reads as the same
// kind of object as any other media tile in the app, not a bespoke widget.

import { useState } from 'react';
import {
  Play, Pause, Heart, MoreHorizontal, ListPlus, Pencil, Trash2, Download,
} from 'lucide-react';
import { SongArtwork } from './SongArtwork';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';
import { Badge } from '../../components/ui/badge';
import { Input } from '../../components/ui/input';
import { cn } from '../../lib/utils';
import { formatDuration } from './format';
import type { Song } from '../../types/ace';

export interface SongCardProps {
  song: Song;
  isCurrent: boolean;
  isPlaying: boolean;
  onPlay: () => void;
  onToggleFavorite: () => void;
  onAddToPlaylist: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
  /** Small solid badge over the top-left of the cover, e.g. "New". */
  badge?: string;
}

export function SongCard({
  song, isCurrent, isPlaying, onPlay, onToggleFavorite, onAddToPlaylist, onRename, onDelete, badge,
}: SongCardProps) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(song.title);

  const commitRename = () => {
    setEditing(false);
    const trimmed = title.trim();
    if (trimmed && trimmed !== song.title) onRename(trimmed);
    else setTitle(song.title);
  };

  return (
    <div
      className={cn(
        'group relative flex flex-col overflow-hidden rounded-xl bg-muted ring-1 ring-border shadow-sm transition-all hover:shadow-lg hover:-translate-y-0.5',
        isCurrent && 'ring-2 ring-brand',
      )}
    >
      <button
        type="button"
        onClick={onPlay}
        className="relative block aspect-square w-full overflow-hidden"
        aria-label={isCurrent && isPlaying ? `Pause ${song.title}` : `Play ${song.title}`}
      >
        <SongArtwork song={song} size="full" />

        {/* Hover dim so overlaid icons/pills stay legible over bright art. */}
        <div
          className={cn(
            'pointer-events-none absolute inset-0 bg-black/0 transition-colors',
            'group-hover:bg-black/35',
            isCurrent && isPlaying && 'bg-black/25',
          )}
        />

        {/* Center play/pause — always visible while this card is the
            active song, otherwise revealed on hover. */}
        <div
          className={cn(
            'absolute inset-0 flex items-center justify-center transition-opacity',
            isCurrent && isPlaying ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
          )}
        >
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-background/95 text-foreground shadow-lg">
            {isCurrent && isPlaying
              ? <Pause className="h-4 w-4" fill="currentColor" />
              : <Play className="h-4 w-4 translate-x-0.5" fill="currentColor" />}
          </span>
        </div>

        {badge && (
          <span className="absolute left-1.5 top-1.5">
            <Badge variant="brand" treatment="solid">{badge}</Badge>
          </span>
        )}
        <span className="absolute bottom-1.5 left-1.5 pointer-events-none">
          <Badge variant="overlay">{formatDuration(song.duration)}</Badge>
        </span>
      </button>

      {/* Favorite + menu — revealed on hover, matching GalleryTile. */}
      <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggleFavorite(); }}
          className="rounded-full border border-border bg-popover/80 p-1 text-foreground backdrop-blur transition-colors hover:text-brand"
          aria-label={song.favorite ? 'Unfavorite' : 'Favorite'}
        >
          <Heart className="h-3.5 w-3.5" fill={song.favorite ? 'currentColor' : 'none'} />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              onClick={(e) => e.stopPropagation()}
              className="rounded-full border border-border bg-popover/80 p-1 text-foreground backdrop-blur transition-colors hover:text-foreground"
              aria-label="Song actions"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            <DropdownMenuItem onSelect={() => setEditing(true)}>
              <Pencil /> Rename
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onAddToPlaylist}>
              <ListPlus /> Add to playlist
            </DropdownMenuItem>
            {song.audioUrl && (
              <DropdownMenuItem onSelect={() => window.open(song.audioUrl!, '_blank')}>
                <Download /> Download
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onDelete}>
              <Trash2 /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Persistent favorite mark when starred (even without hover). */}
      {song.favorite && (
        <div className="pointer-events-none absolute right-2 top-2 opacity-100 transition-opacity group-hover:opacity-0">
          <Heart className="h-3.5 w-3.5 fill-brand text-brand drop-shadow" />
        </div>
      )}

      <div className="min-w-0 p-2">
        {editing ? (
          <Input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') { setTitle(song.title); setEditing(false); }
            }}
            className="h-6 text-xs"
          />
        ) : (
          <div className={cn('truncate text-sm font-medium', isCurrent ? 'text-brand' : 'text-foreground')}>
            {song.title}
          </div>
        )}
        <div className="truncate text-xs text-muted-foreground">
          {song.style || song.caption || 'Untitled style'}
        </div>
      </div>
    </div>
  );
}

export default SongCard;
