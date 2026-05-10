// Reusable sticky-pinned rounded-card aside for page layouts that follow
// the Chat / Models pattern (left sidebar + main content, both detached
// cards inside a `flex gap-4 p-4` wrapper).
//
// On lg+ screens: 320px wide, sticky top-[104px] (clears TopBar +
// PageSubbar), height-bounded so its content can scroll independently of
// the body. On mobile: hidden by default; pass `open` to surface it as a
// full-width card above the main content (used by pages that have a
// "Filters" toggle in the subbar).

import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

interface Props {
  children: ReactNode;
  /** When true, the aside is rendered as a full-width card on mobile.
   *  Defaults to false — mobile users only see it after toggling. */
  open?: boolean;
  className?: string;
}

export default function PageAside({ children, open = false, className }: Props) {
  return (
    <aside
      className={cn(
        // The aside itself scrolls when its content overflows (long
        // filter stacks, deep conversation lists, etc.) but the scrollbar
        // is hidden so the card visual stays clean. Inner scroll
        // containers keep their own visible scrollbars.
        'flex-col rounded-xl border bg-card shadow-sm overflow-y-auto no-scrollbar',
        // Desktop: sticky 320px column on the left. Height cap clears
        // both the top offset (104px for TopBar + subbar) and the inset's
        // bottom margin / rounded-corner zone (~20px). Without enough
        // bottom clearance the sticky's stop point is reached at max
        // scroll and the aside visibly shifts up by a few px toward the
        // subbar — the "Plugins doesn't do this" bug we hunted down.
        'lg:sticky lg:top-[104px] lg:flex lg:h-[calc(100vh-140px)] lg:w-[320px] lg:shrink-0',
        // Mobile gating: shown as a full-width card only when `open`.
        open ? 'flex w-full' : 'hidden lg:flex',
        className,
      )}
    >
      {children}
    </aside>
  );
}
