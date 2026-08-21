// One song in a list (Library grid, playlist detail, etc). Play on click,
// favorite/menu actions on the right. Ported from ace-step-ui's
// `SongList.tsx` row + `SongDropdownMenu.tsx`, rebuilt on comfy's
// DropdownMenu/Button/Badge primitives.

import { useState } from 'react';
import {
  Play, Pause, Heart, MoreHorizontal, ListPlus, Pencil, Trash2, Download,
} from 'lucide-react';
import { SongArtwork } from './SongArtwork';
import { Button } from '../../components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';
import { Input } from '../../components/ui/input';
import { cn } from '../../lib/utils';
import { formatDuration } from './format';
import type { Song } from '../../types/ace';

export interface SongRowProps {
  song: Song;
  index?: number;
  isCurrent: boolean;
  isPlaying: boolean;
  onPlay: () => void;
  onToggleFavorite: () => void;
  onAddToPlaylist: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
  onReuseAsPrompt?: () => void;
}

export function SongRow({
  song, index, isCurrent, isPlaying, onPlay, onToggleFavorite, onAddToPlaylist, onRename, onDelete, onReuseAsPrompt,
}: SongRowProps) {
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
        'group flex items-center gap-3 rounded-lg px-2 py-2 transition-colors cursor-pointer',
        isCurrent ? 'bg-brand/10' : 'hover:bg-muted',
      )}
      onClick={onPlay}
    >
      {index !== undefined && (
        <span className="w-5 shrink-0 text-center text-xs text-muted-foreground tabular-nums">
          {isCurrent && isPlaying ? (
            <Pause className="mx-auto h-3.5 w-3.5 text-brand" />
          ) : isCurrent ? (
            <Play className="mx-auto h-3.5 w-3.5 text-brand" />
          ) : (
            index + 1
          )}
        </span>
      )}

      <SongArtwork song={song} size="sm" className="h-10 w-10 shrink-0 rounded object-cover" />

      <div className="min-w-0 flex-1">
        {editing ? (
          <Input
            autoFocus
            value={title}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') { setTitle(song.title); setEditing(false); }
            }}
            className="h-7 text-sm"
          />
        ) : (
          <div className={cn('truncate text-sm font-medium', isCurrent ? 'text-brand' : 'text-foreground')}>
            {song.title}
          </div>
        )}
        <div className="truncate text-xs text-muted-foreground">{song.style || song.caption || 'Untitled style'}</div>
      </div>

      <span className="shrink-0 text-xs font-mono text-muted-foreground">{formatDuration(song.duration)}</span>

      <Button
        variant="ghost"
        size="icon-sm"
        className={cn(song.favorite && 'text-brand')}
        aria-label={song.favorite ? 'Unfavorite' : 'Favorite'}
        onClick={(e) => { e.stopPropagation(); onToggleFavorite(); }}
      >
        <Heart className="h-3.5 w-3.5" fill={song.favorite ? 'currentColor' : 'none'} />
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Song actions"
            onClick={(e) => e.stopPropagation()}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
          <DropdownMenuItem onSelect={() => setEditing(true)}>
            <Pencil /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onAddToPlaylist}>
            <ListPlus /> Add to playlist
          </DropdownMenuItem>
          {onReuseAsPrompt && (
            <DropdownMenuItem onSelect={onReuseAsPrompt}>
              <Pencil /> Reuse as prompt
            </DropdownMenuItem>
          )}
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
  );
}

export default SongRow;
