// Persistent bottom player bar for the Music page. Ported from ace-step-ui's
// `Player.tsx` (trimmed to the desktop bar — no fullscreen/mobile-drawer
// variant), rebuilt on comfy's Slider/Button primitives. Renders `null`
// until something has been played, mirroring most streaming-app players.

import { useState } from 'react';
import {
  Play, Pause, SkipBack, SkipForward, Repeat, Repeat1, Shuffle, Heart,
  Volume2, VolumeX, ListPlus, MoreHorizontal, Trash2,
} from 'lucide-react';
import { AlbumCover } from './AlbumCover';
import { Button } from '../../components/ui/button';
import { Slider } from '../../components/ui/slider';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';
import { cn } from '../../lib/utils';
import { useMusic } from './MusicContext';

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function PlayerBar() {
  const {
    currentSong, isPlaying, currentTime, duration, volume, repeatMode, shuffle,
    togglePlay, next, previous, seek, setVolume, cycleRepeat, toggleShuffle,
    toggleFavorite, openAddToPlaylist, removeSong,
  } = useMusic();
  const [preMuteVolume, setPreMuteVolume] = useState(1);

  if (!currentSong) return null;

  const toggleMute = () => {
    if (volume > 0) { setPreMuteVolume(volume); setVolume(0); }
    else setVolume(preMuteVolume || 1);
  };

  return (
    <div className="sticky bottom-0 z-40 border-t border-border bg-card/95 backdrop-blur px-3 py-2.5 sm:px-4">
      <div className="flex items-center gap-3">
        {/* Now playing */}
        <div className="flex min-w-0 flex-1 items-center gap-3 sm:flex-none sm:w-56">
          {currentSong.coverUrl ? (
            <img src={currentSong.coverUrl} alt="" className="h-11 w-11 shrink-0 rounded object-cover" />
          ) : (
            <AlbumCover seed={currentSong.id} size="sm" className="h-11 w-11" />
          )}
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

        {/* Volume + menu */}
        <div className="hidden shrink-0 items-center gap-2 sm:flex sm:w-40">
          <Button variant="ghost" size="icon-sm" aria-label={volume > 0 ? 'Mute' : 'Unmute'} onClick={toggleMute}>
            {volume > 0 ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}
          </Button>
          <Slider
            value={[volume]}
            min={0}
            max={1}
            step={0.01}
            onValueChange={([v]) => setVolume(v)}
            className="w-20"
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

export default PlayerBar;
