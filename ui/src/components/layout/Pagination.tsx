// Reusable rounded-pill pager. Self-contained: includes its own top margin,
// border, and surface so consumers render `<Pagination ... />` directly with
// no wrapper. Page-jump input appears once totalPages > 10. Renders nothing
// when there's nothing to page through.

import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  SelectField,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../forms/SelectField';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';

const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
const JUMP_THRESHOLD = 10;

export interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  /** Hide the whole control when there's nothing to page through. Defaults to true. */
  hideWhenEmpty?: boolean;
  className?: string;
}

export default function Pagination({
  page,
  pageSize,
  total,
  hasMore,
  onPageChange,
  onPageSizeChange,
  hideWhenEmpty = true,
  className = '',
}: PaginationProps) {
  const totalPages = total === 0 ? 1 : Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const canPrev = safePage > 1;
  const canNext = hasMore && safePage < totalPages;
  const showJump = totalPages > JUMP_THRESHOLD;
  const [jumpRaw, setJumpRaw] = useState('');

  if (hideWhenEmpty && total === 0) return null;

  const commitJump = () => {
    const trimmed = jumpRaw.trim();
    if (!trimmed) return;
    const n = parseInt(trimmed, 10);
    if (Number.isFinite(n) && n >= 1 && n <= totalPages && n !== safePage) {
      onPageChange(n);
    }
    setJumpRaw('');
  };

  return (
    <div
      className={cn(
        'mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted px-4 py-2',
        className,
      )}
    >
      <div className="flex items-center gap-2 text-xs text-foreground">
        <span>Rows per page</span>
        <SelectField
          value={String(pageSize)}
          onValueChange={(v) => onPageSizeChange(parseInt(v, 10))}
        >
          <SelectTrigger className="h-8 w-[72px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAGE_SIZE_OPTIONS.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n}
              </SelectItem>
            ))}
          </SelectContent>
        </SelectField>
      </div>

      <div className="flex items-center gap-3 text-xs text-foreground">
        <span aria-live="polite">
          Page <span className="font-semibold text-foreground">{safePage}</span> of{' '}
          <span className="font-semibold text-foreground">{totalPages}</span>
          {total > 0 && (
            <span className="text-muted-foreground"> · {total.toLocaleString()} total</span>
          )}
        </span>
        {showJump && (
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="hidden sm:inline">Go to</span>
            <input
              type="number"
              min={1}
              max={totalPages}
              value={jumpRaw}
              onChange={(e) => setJumpRaw(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') commitJump(); }}
              onBlur={commitJump}
              placeholder={String(safePage)}
              aria-label={`Jump to page (1 to ${totalPages})`}
              className="h-7 w-16 rounded-md border bg-background px-2 text-xs text-foreground tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
          </label>
        )}
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="secondary"
            onClick={() => onPageChange(safePage - 1)}
            disabled={!canPrev}
            aria-label="Previous page"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
            Prev
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => onPageChange(safePage + 1)}
            disabled={!canNext}
            aria-label="Next page"
          >
            Next
            <ChevronRight className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
