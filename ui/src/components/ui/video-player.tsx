import { X } from 'lucide-react';
import { cn } from '../../lib/utils';

interface VideoPlayerProps {
  src: string;
  className?: string;
  /** Called when the user clicks the remove button. When omitted the button is hidden. */
  onRemove?: () => void;
  /** Optional filename shown as a small caption in the bottom corner. */
  fileName?: string;
}

export function VideoPlayer({ src, className, onRemove, fileName }: VideoPlayerProps) {
  return (
    <div className={cn('relative rounded-lg overflow-hidden border bg-card', className)}>
      <video
        src={src}
        controls
        className="w-full max-h-48 block"
      />
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove video"
          className="absolute top-2 right-2 flex h-6 w-6 items-center justify-center rounded-full bg-foreground/50 text-background hover:bg-foreground/70 transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
      {fileName && (
        <span className="absolute bottom-2 left-2 max-w-[70%] truncate rounded bg-foreground/50 px-1.5 py-0.5 text-[10px] text-background">
          {fileName}
        </span>
      )}
    </div>
  );
}
