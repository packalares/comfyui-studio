// Responsive N-thumbnail storyboard grid.
// Each shot maps to a <ShotCard>. Empty state shown when no shots exist.
// Header above the grid shows progress (N/M shots have images) plus a
// "Generate All" button that queues every shot without an image.

import { Film, LayoutGrid, Link2, Loader2, Sparkles } from 'lucide-react';
import { Button } from '../ui/button';
import { ShotCard } from './ShotCard';
import type { Project } from '../../api/videoboard';

export interface StoryboardGridProps {
  project: Project;
  onShotEdit: (idx: number) => void;
  onShotRegenerate: (idx: number) => void;
  /** Triggers POST /shots/images/generate-all. When omitted, the button is
   *  hidden — keeps the component reusable in contexts that don't allow batch
   *  ops (e.g. a read-only history view, if we ever ship one). */
  onGenerateAllImages?: () => void;
  /** Triggers POST /shots/videos/generate-all. Enabled only when every non-last
   *  shot has an image (FLF2V needs current + next as start/end frames). */
  onGenerateAllVideos?: () => void;
  /** Triggers POST /shots/chain/generate. Enabled only when shot 0 has an
   *  imageUrl — chain mode bootstraps from the first shot's image and feeds
   *  each saved latent into the next shot. Slower but more consistent than
   *  parallel FLF2V. */
  onGenerateChainVideos?: () => void;
}

export function StoryboardGrid({
  project,
  onShotEdit,
  onShotRegenerate,
  onGenerateAllImages,
  onGenerateAllVideos,
  onGenerateChainVideos,
}: StoryboardGridProps) {
  const { shots } = project;

  if (shots.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16 text-center text-muted-foreground">
        <LayoutGrid className="w-10 h-10 opacity-30" />
        <p className="text-sm font-medium">Storyboard not generated yet</p>
        <p className="text-xs opacity-70 max-w-xs">
          Use the{' '}
          <span className="font-semibold text-foreground">Generate Storyboard</span>{' '}
          button to create shots from the audio analysis.
        </p>
      </div>
    );
  }

  const withImage = shots.filter((s) => !!s.imageUrl).length;
  const inFlight = shots.filter((s) => s.status === 'generating' || s.status === 'queued').length;
  const remaining = shots.length - withImage;
  const batchBusy = inFlight > 0;

  // FLF2V eligibility: every shot EXCEPT the last needs an image. The last
  // shot is skipped (no next frame). A shot is video-eligible only when both
  // it AND the next shot have an image.
  const lastIdx = shots.length - 1;
  const videoEligibleShots = shots.filter((s, i) => {
    if (i === shots.length - 1) return false;        // last shot — no next
    const next = shots[i + 1];
    return !!s.imageUrl && !!next?.imageUrl && !s.videoUrl;
  });
  const withVideo = shots.filter((s) => !!s.videoUrl).length;
  const allImagesReady = shots.slice(0, lastIdx).every((s) => !!s.imageUrl);
  const videoRemaining = videoEligibleShots.length;

  // Chain mode only needs shot 0's image as a seed; subsequent shots reuse the
  // previous shot's saved latent. So the gating is intentionally looser than
  // FLF2V (which needs every shot+next pair). Re-running chain when some shots
  // already have videoUrls is allowed — the backend will overwrite them.
  const chainSeedReady = !!shots[0]?.imageUrl;

  return (
    <div className="flex flex-col gap-4">
      {/* Header — progress + batch CTA */}
      <div className="flex items-center justify-between gap-3 px-0.5">
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span>
            <span className="font-semibold text-foreground">{withImage}</span> / {shots.length} shots have images
          </span>
          {inFlight > 0 && (
            <span className="flex items-center gap-1.5 text-amber-500">
              <Loader2 className="h-3 w-3 animate-spin" />
              {inFlight} in flight
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {onGenerateAllImages && (
            <Button
              type="button"
              size="sm"
              onClick={onGenerateAllImages}
              disabled={batchBusy || remaining === 0}
              className="gap-2"
              title={remaining === 0 ? 'All shots already have images.' : undefined}
            >
              {batchBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              {remaining === 0
                ? 'All shots done'
                : batchBusy
                  ? 'Generating…'
                  : `Generate All (${remaining})`}
            </Button>
          )}
          {onGenerateAllVideos && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={onGenerateAllVideos}
              disabled={batchBusy || !allImagesReady || videoRemaining === 0}
              className="gap-2"
              title={
                !allImagesReady
                  ? 'Generate all images first — FLF2V needs each shot + its next as start/end frames.'
                  : videoRemaining === 0
                    ? `All ${withVideo} videos already generated. The last shot is skipped (no next frame).`
                    : `Generate ${videoRemaining} videos. The last shot is skipped.`
              }
            >
              <Film className="h-3.5 w-3.5" />
              {!allImagesReady
                ? 'Videos: need all images'
                : videoRemaining === 0
                  ? 'All videos done'
                  : `Generate All Videos (${videoRemaining})`}
            </Button>
          )}
          {onGenerateChainVideos && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={onGenerateChainVideos}
              disabled={batchBusy || !chainSeedReady}
              className="gap-2"
              title={
                !chainSeedReady
                  ? 'Generate shot 1’s image first — chain mode needs a starting frame.'
                  : 'Generates videos sequentially, each chained to the previous shot’s latent. Slower but more consistent than parallel FLF2V.'
              }
            >
              <Link2 className="h-3.5 w-3.5" />
              {!chainSeedReady
                ? 'Chain: need shot 1 image'
                : `Generate Video Chain (${shots.length})`}
            </Button>
          )}
        </div>
      </div>

      <div
        className="grid gap-4"
        style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}
      >
        {shots.map((shot, i) => (
          <div key={shot.idx} className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground font-medium px-0.5">
              Shot {i + 1} of {shots.length}
            </span>
            <ShotCard
              shot={shot}
              onEdit={() => onShotEdit(shot.idx)}
              onRegenerate={() => onShotRegenerate(shot.idx)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
