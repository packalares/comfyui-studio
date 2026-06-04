// Waveform — real waveform rendering via wavesurfer.js 7.x.
//
// Bidirectional sync strategy: Option B (state-driven).
// - AnalyzeView owns the <audio> element and tracks currentTime via timeupdate,
//   passing it here as the `currentTime` prop.
// - On prop change, Waveform calls ws.setTime() to move the progress cursor.
// - On user click (wavesurfer 'interaction' event), Waveform calls onSeek(t)
//   so the parent can set audio.currentTime.

import { useEffect, useRef } from 'react';
import WaveSurfer from 'wavesurfer.js';

export interface WaveformProps {
  src: string;
  /** External controlled playback position (seconds). Parent keeps in sync via audio timeupdate. */
  currentTime?: number;
  /** Called when user clicks to seek, with the new position in seconds. */
  onSeek?: (t: number) => void;
  /** Height in pixels. Defaults to 60. */
  height?: number;
}

export function Waveform({ src, currentTime, onSeek, height = 60 }: WaveformProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  // Guard: skip setTime() for the tick immediately following a user-initiated seek
  // to avoid a feedback loop (user click → onSeek → parent state → currentTime prop → setTime).
  const skipNextSyncRef = useRef(false);

  useEffect(() => {
    if (!containerRef.current) return;

    const ws = WaveSurfer.create({
      container: containerRef.current,
      height,
      // Use CSS custom properties for colour — no hardcoded hex.
      waveColor: 'color-mix(in srgb, var(--muted-foreground) 45%, transparent)',
      progressColor: 'var(--foreground)',
      url: src,
      interact: true,
      normalize: true,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
    });

    // 'interaction' fires when the user clicks/drags the waveform.
    ws.on('interaction', (newTime: number) => {
      skipNextSyncRef.current = true;
      onSeek?.(newTime);
    });

    wsRef.current = ws;

    return () => {
      ws.destroy();
      wsRef.current = null;
    };
    // Re-create WaveSurfer when src or height changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, height]);

  // Sync parent audio position into WaveSurfer progress cursor.
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || currentTime == null) return;
    if (skipNextSyncRef.current) {
      skipNextSyncRef.current = false;
      return;
    }
    // ws.setTime() is the WaveSurfer 7.x API for programmatic seek without
    // triggering audio playback through wavesurfer's own media element.
    ws.setTime(currentTime);
  }, [currentTime]);

  return (
    <div
      ref={containerRef}
      aria-label="Audio waveform — click to seek"
      className="w-full overflow-hidden rounded-md"
      style={{ height }}
    />
  );
}
