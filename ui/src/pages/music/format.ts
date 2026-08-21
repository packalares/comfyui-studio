// Shared mm:ss formatting for the Music page. Both the player's elapsed/total
// time and a song row/card's fixed duration used the same floor(seconds/60)
// logic with slightly different fallback text — factored out once so
// PlayerBar/SongRow/SongCard don't each carry their own copy.

/** Elapsed/seek time — falls back to `0:00` (used while metadata loads). */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Fixed song duration — falls back to `--:--` (used when unknown, not 0:00,
 *  so an unset duration doesn't read as "zero seconds long"). */
export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return '--:--';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
