// Floating "scroll to latest" affordance — replaces the old
// <ConversationScrollButton> that hung off the StickToBottom context. The
// chat page now scrolls the document body, so this watches `window.scroll`
// directly and only renders when the user is more than ~240px above the
// bottom. Click smooth-scrolls to the document end.
//
// Positioning is `absolute` (not `fixed`) so the FAB anchors to the sticky
// composer wrapper and inherits its centered max-width — fixed-to-viewport
// would centre against the page (including the left aside) and read as
// off-centre against the chat column.

import { useEffect, useState } from 'react';
import { ArrowDown } from 'lucide-react';

export default function ScrollToBottomFab() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const update = () => {
      const distance =
        document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
      setShow(distance > 240);
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  if (!show) return null;
  return (
    <button
      type="button"
      onClick={() => window.scrollTo({
        top: document.documentElement.scrollHeight,
        behavior: 'smooth',
      })}
      aria-label="Scroll to latest"
      className="absolute -top-12 left-1/2 z-30 inline-flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border bg-card text-foreground shadow-lg hover:bg-muted cursor-pointer transition-colors"
    >
      <ArrowDown className="h-4 w-4" />
    </button>
  );
}
