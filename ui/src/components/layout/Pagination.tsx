// Small, reusable paging controls. Matches the DownloadsTab/Models aesthetic —
// btn-secondary for arrow buttons, shadcn Select for page size. Renders nothing
// when there's only one page AND default page size (keeps the layout quiet).

import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  SelectField,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../forms/SelectField';
import { Button } from '../ui/button';

const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;

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

  if (hideWhenEmpty && total === 0) return null;

  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-4 py-2 ${className}`}
    >
      <div className="flex items-center gap-2 text-xs text-slate-600">
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

      <div className="flex items-center gap-3 text-xs text-slate-600">
        <span aria-live="polite">
          Page <span className="font-semibold text-slate-900">{safePage}</span> of{' '}
          <span className="font-semibold text-slate-900">{totalPages}</span>
          {total > 0 && (
            <span className="text-slate-400"> · {total.toLocaleString()} total</span>
          )}
        </span>
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
