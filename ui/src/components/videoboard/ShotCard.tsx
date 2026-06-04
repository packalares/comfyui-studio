// Single shot tile for the Storyboard grid.
// Shows thumbnail (or placeholder), lyrics, timing, status badge.
// Hover overlay exposes Edit + Regenerate icon buttons.

import { useState } from 'react';
import { ImageIcon, Edit2, RefreshCw, AlertTriangle, Clock } from 'lucide-react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Spinner } from '../ui/spinner';
import type { Shot } from '../../api/videoboard';
import type { BadgeVariant } from '../ui/badge';

export interface ShotCardProps {
  shot: Shot;
  onEdit: () => void;
  onRegenerate: () => void;
}

function formatMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

const STATUS_BADGE: Record<Shot['status'], BadgeVariant> = {
  ready:      'success',
  generating: 'warning',
  queued:     'warning',
  error:      'danger',
  pending:    'neutral',
};

const STATUS_LABEL: Record<Shot['status'], string> = {
  ready:      'Ready',
  generating: 'Generating',
  queued:     'Queued',
  error:      'Error',
  pending:    'Pending',
};

export function ShotCard({ shot, onEdit, onRegenerate }: ShotCardProps) {
  const [hovered, setHovered] = useState(false);
  const isActive = shot.status === 'generating' || shot.status === 'queued';

  const timing = `${formatMs(shot.startMs)}–${formatMs(shot.endMs)}`;

  return (
    <article
      className="card overflow-hidden flex flex-col cursor-pointer group"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onEdit}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onEdit();
        }
      }}
      aria-label={`Shot ${shot.idx + 1}, ${timing}`}
    >
      {/* Thumbnail */}
      <div className="aspect-video relative overflow-hidden bg-muted shrink-0">
        {shot.imageUrl ? (
          <img
            src={shot.imageUrl}
            alt={`Shot ${shot.idx + 1}`}
            className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
            loading="lazy"
            decoding="async"
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-muted-foreground">
            {shot.status === 'generating' ? (
              <Spinner size="xl" />
            ) : shot.status === 'error' ? (
              <AlertTriangle className="w-8 h-8 text-destructive" />
            ) : (
              <ImageIcon className="w-8 h-8 opacity-40" />
            )}
          </div>
        )}

        {/* Status badge */}
        <div className="absolute top-2 right-2">
          <Badge variant={STATUS_BADGE[shot.status]}>
            {STATUS_LABEL[shot.status]}
          </Badge>
        </div>

        {/* Timing badge */}
        <div className="absolute bottom-2 left-2 flex items-center gap-1 text-[10px] text-white/90 bg-black/50 rounded px-1.5 py-0.5">
          <Clock className="w-3 h-3" />
          {timing}
        </div>

        {/* Hover overlay */}
        {hovered && (
          <div
            className="absolute inset-0 flex items-center justify-center gap-2 bg-foreground/30"
            onClick={(e) => e.stopPropagation()}
          >
            <Button
              type="button"
              variant="secondary"
              size="icon"
              aria-label="Edit shot prompt"
              onClick={(e) => {
                e.stopPropagation();
                onEdit();
              }}
            >
              <Edit2 className="w-4 h-4" />
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="icon"
              aria-label="Regenerate shot"
              disabled={isActive}
              onClick={(e) => {
                e.stopPropagation();
                onRegenerate();
              }}
            >
              {isActive ? (
                <Spinner size="sm" />
              ) : (
                <RefreshCw className="w-4 h-4" />
              )}
            </Button>
          </div>
        )}
      </div>

      {/* Lyrics */}
      <div className="p-3 flex-1">
        <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
          {shot.lyrics || <span className="italic opacity-60">No lyrics</span>}
        </p>
      </div>
    </article>
  );
}
