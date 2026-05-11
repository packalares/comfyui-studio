import { useState, useRef, useEffect, useCallback } from 'react';
import { Play, Pause, RotateCcw, RotateCw, X } from 'lucide-react';
import { Slider } from './slider';
import { cn } from '../../lib/utils';

interface AudioPlayerProps {
  src: string;
  className?: string;
  /** Optional filename shown truncated inside the player bar. */
  fileName?: string;
  /** Called when the user clicks the remove button. When omitted the button is hidden. */
  onRemove?: () => void;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function AudioPlayer({ src, className, fileName, onRemove }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    // Reset state when src changes.
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
  }, [src]);

  const handlePlayPause = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      void el.play();
    } else {
      el.pause();
    }
  }, []);

  const skip = useCallback((delta: number) => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, Math.min(el.duration || 0, el.currentTime + delta));
  }, []);

  const handleScrub = useCallback(([v]: number[]) => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = v;
    setCurrentTime(v);
  }, []);

  return (
    <div className={cn('audio-player', className)}>
      {/* Hidden audio element — all state is synced via event handlers. */}
      <audio
        ref={audioRef}
        src={src}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={() => {
          const el = audioRef.current;
          if (el) setCurrentTime(el.currentTime);
        }}
        onLoadedMetadata={() => {
          const el = audioRef.current;
          if (el) setDuration(el.duration);
        }}
        preload="metadata"
      />

      <button type="button" onClick={handlePlayPause} className="audio-player-btn" aria-label={playing ? 'Pause' : 'Play'}>
        {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
      </button>

      <button type="button" onClick={() => skip(-10)} className="audio-player-btn audio-player-btn--skip" aria-label="Skip back 10 seconds">
        <RotateCcw className="w-3.5 h-3.5" />
        <span className="text-[9px] font-bold leading-none">10</span>
      </button>

      <button type="button" onClick={() => skip(10)} className="audio-player-btn audio-player-btn--skip" aria-label="Skip forward 10 seconds">
        <RotateCw className="w-3.5 h-3.5" />
        <span className="text-[9px] font-bold leading-none">10</span>
      </button>

      {fileName && (
        <span className="audio-player-filename">{fileName}</span>
      )}

      <span className="audio-player-time">{formatTime(currentTime)}</span>

      <div className="flex-1 min-w-0">
        <Slider
          value={[currentTime]}
          onValueChange={handleScrub}
          min={0}
          max={duration || 1}
          step={0.1}
        />
      </div>

      <span className="audio-player-time">{formatTime(duration)}</span>

      {onRemove && (
        <button type="button" onClick={onRemove} className="audio-player-btn" aria-label="Remove audio">
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}
