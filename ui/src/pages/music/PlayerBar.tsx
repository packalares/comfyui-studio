// Persistent bottom player bar for the Music page. Ported from ace-step-ui's
// `Player.tsx` (trimmed to the desktop bar — no fullscreen/mobile-drawer
// variant), rebuilt on comfy's Slider/Button primitives. Renders `null`
// until something has been played, mirroring most streaming-app players.

import { useState } from 'react';
import {
  Play, Pause, SkipBack, SkipForward, Repeat, Repeat1, Shuffle, Heart,
  Volume2, VolumeX, ListPlus, MoreHorizontal, Trash2, ListMusic,
} from 'lucide-react';
import { SongArtwork } from './SongArtwork';
import { Button } from '../../components/ui/button';
import { Slider } from '../../components/ui/slider';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { cn } from '../../lib/utils';
import { useMusic } from './MusicContext';
import { formatTime, formatDuration } from './format';
import type { Song } from '../../types/ace';

export function PlayerBar() {
  const {
    queue, currentIndex, currentSong, isPlaying, currentTime, duration, volume, repeatMode, shuffle,
    playSong, togglePlay, next, previous, seek, setVolume, cycleRepeat, toggleShuffle,
    toggleFavorite, openAddToPlaylist, removeSong,
  } = useMusic();
  const [preMuteVolume, setPreMuteVolume] = useState(1);
  const [queueOpen, setQueueOpen] = useState(false);

  if (!currentSong) return null;

  const toggleMute = () => {
    if (volume > 0) { setPreMuteVolume(volume); setVolume(0); }
    else setVolume(preMuteVolume || 1);
  };

  return (
    <div className="sticky bottom-0 z-40 border-t border-border bg-card/95 backdrop-blur shadow-[0_-4px_16px_-4px_rgba(0,0,0,0.12)] px-3 py-2.5 sm:px-4">
      <div className="flex items-center gap-3">
        {/* Now playing — the anchor of the bar, so the cover reads a size
            up from every other icon here. */}
        <div className="flex min-w-0 flex-1 items-center gap-3 sm:flex-none sm:w-56">
          <SongArtwork
            song={currentSong}
            size="md"
            className="h-12 w-12 shrink-0 rounded-md object-cover shadow-sm"
          />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-foreground">{currentSong.title}</div>
            <div className="truncate text-xs text-muted-foreground">{currentSong.style || 'ACE-Step'}</div>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn('shrink-0', currentSong.favorite && 'text-brand')}
            aria-label={currentSong.favorite ? 'Unfavorite' : 'Favorite'}
            onClick={() => void toggleFavorite(currentSong)}
          >
            <Heart className="h-3.5 w-3.5" fill={currentSong.favorite ? 'currentColor' : 'none'} />
          </Button>
        </div>

        {/* Transport + scrub */}
        <div className="flex min-w-0 flex-1 flex-col items-center gap-1">
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Shuffle"
              className={cn(shuffle && 'text-brand')}
              onClick={toggleShuffle}
            >
              <Shuffle className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Previous" onClick={previous}>
              <SkipBack className="h-4 w-4" />
            </Button>
            <Button variant="default" size="icon-sm" aria-label={isPlaying ? 'Pause' : 'Play'} onClick={togglePlay}>
              {isPlaying ? <Pause className="h-4 w-4" fill="currentColor" /> : <Play className="h-4 w-4" fill="currentColor" />}
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Next" onClick={next}>
              <SkipForward className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Repeat"
              className={cn(repeatMode !== 'none' && 'text-brand')}
              onClick={cycleRepeat}
            >
              {repeatMode === 'one' ? <Repeat1 className="h-3.5 w-3.5" /> : <Repeat className="h-3.5 w-3.5" />}
            </Button>
          </div>
          <div className="flex w-full max-w-lg items-center gap-2">
            <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
              {formatTime(currentTime)}
            </span>
            <Slider
              value={[currentTime]}
              min={0}
              max={duration || 1}
              step={0.1}
              onValueChange={([v]) => seek(v)}
            />
            <span className="w-9 shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {formatTime(duration)}
            </span>
          </div>
        </div>

        {/* Queue + volume + menu */}
        <div className="hidden shrink-0 items-center gap-1.5 sm:flex sm:w-52">
          <Popover open={queueOpen} onOpenChange={setQueueOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Queue"
                className={cn(queueOpen && 'text-brand', queue.length === 0 && 'opacity-50')}
                disabled={queue.length === 0}
              >
                <ListMusic className="h-3.5 w-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 p-2">
              <QueuePanel
                queue={queue}
                currentIndex={currentIndex}
                onPlay={(song) => { playSong(song, queue); setQueueOpen(false); }}
              />
            </PopoverContent>
          </Popover>
          <Button variant="ghost" size="icon-sm" aria-label={volume > 0 ? 'Mute' : 'Unmute'} onClick={toggleMute}>
            {volume > 0 ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}
          </Button>
          <Slider
            value={[volume]}
            min={0}
            max={1}
            step={0.01}
            onValueChange={([v]) => setVolume(v)}
            className="w-16"
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="More">
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => openAddToPlaylist(currentSong)}>
                <ListPlus /> Add to playlist
              </DropdownMenuItem>
              {currentSong.audioUrl && (
                <DropdownMenuItem onSelect={() => window.open(currentSong.audioUrl!, '_blank')}>
                  Download
                </DropdownMenuItem>
              )}
              <DropdownMenuItem variant="destructive" onSelect={() => void removeSong(currentSong)}>
                <Trash2 /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}

/** Up-next list, opened from the queue button. Clicking an entry jumps
 *  playback to it without disturbing the rest of the queue's order. */
function QueuePanel({
  queue, currentIndex, onPlay,
}: { queue: Song[]; currentIndex: number | null; onPlay: (song: Song) => void }) {
  if (queue.length === 0) {
    return <p className="px-2 py-3 text-center text-xs text-muted-foreground">Queue is empty.</p>;
  }
  return (
    <div className="max-h-80 space-y-0.5 overflow-y-auto">
      <p className="px-2 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Up next · {queue.length}
      </p>
      {queue.map((song, idx) => {
        const active = idx === currentIndex;
        return (
          <button
            key={`${song.id}-${idx}`}
            type="button"
            onClick={() => onPlay(song)}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
              active ? 'bg-brand/10' : 'hover:bg-muted',
            )}
          >
            <SongArtwork song={song} size="xs" className="h-8 w-8 shrink-0 rounded object-cover" />
            <div className="min-w-0 flex-1">
              <div className={cn('truncate text-xs font-medium', active ? 'text-brand' : 'text-foreground')}>
                {song.title}
              </div>
              <div className="truncate text-[11px] text-muted-foreground">{song.style || 'ACE-Step'}</div>
            </div>
            <span className="shrink-0 text-[10px] font-mono tabular-nums text-muted-foreground">
              {formatDuration(song.duration)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default PlayerBar;
