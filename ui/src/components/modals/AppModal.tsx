// Shared modal primitive. Centers a `.panel` shell over a dimmed backdrop
// and consolidates the Esc + backdrop-click close gestures that were
// re-implemented in every modal before Wave O.
//
// Visual language matches ImportWorkflowModal / GalleryDetailModal — the
// two modals the rest of the app already converged on. Callers that need
// a different layout (e.g. step-aware headers) pass the entire header via
// the `header` slot; AppModal still owns the Esc/backdrop behaviour.

import { useEffect, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from '../ui/button';
import { Card, CardContent, CardFooter, CardHeader } from '../ui/card';

// Matches the `duration-150` class on the panel's exit animation below.
// Keep in sync if the class changes.
const CLOSE_ANIMATION_MS = 150;

// Refcount of currently-open AppModals. We only restore the original
// `body.overflow` when the count returns to zero — important when a
// dependency-modal layers on top of an import-review modal etc., so
// closing the inner one doesn't prematurely unlock page scroll while
// the outer one's still open.
let openModalCount = 0;
let savedBodyOverflow: string | null = null;

export interface AppModalProps {
  open: boolean;
  onClose: () => void;
  /** Title text. Omit if you use the `header` slot. */
  title?: string;
  /** Small text under the title in the header. */
  subtitle?: string;
  /** Optional leading icon for the header. */
  icon?: ReactNode;
  /** Size controls the max-width of the panel. */
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** When true, the modal body scrolls; when false, it grows to fit. */
  scrollBody?: boolean;
  /**
   * Disable close gestures while an async op is in flight. Ignored on
   * explicit `onClose` calls — callers stay in control of the close flow
   * from their buttons. Disables: Esc key, X button.
   */
  disableClose?: boolean;
  /**
   * Opt-in: dismiss the modal when the user clicks the dimmed backdrop
   * outside the panel. OFF by default — the global house style is "the
   * modal stays open until you press Esc or hit a button". Flip on for
   * lightweight, low-stakes dialogs where backdrop-click feels natural.
   */
  closeOnBackdropClick?: boolean;
  /** Override header entirely (icon/title/subtitle ignored). Includes the X. */
  header?: ReactNode;
  /** Footer slot — typically a row of buttons. */
  footer?: ReactNode;
  /** Body. */
  children: ReactNode;
  /** Extra class on the panel shell for edge-case tweaks. */
  className?: string;
  /** aria-label override when `title` is empty. */
  ariaLabel?: string;
}

const SIZE_CLASS: Record<NonNullable<AppModalProps['size']>, string> = {
  sm: 'max-w-md',
  md: 'max-w-2xl',
  lg: 'max-w-4xl',
  xl: 'max-w-6xl',
};

export default function AppModal(props: AppModalProps): JSX.Element | null {
  const {
    open,
    onClose,
    title,
    subtitle,
    icon,
    size = 'md',
    scrollBody = true,
    disableClose = false,
    closeOnBackdropClick = false,
    header,
    footer,
    children,
    className,
    ariaLabel,
  } = props;

  // Esc-to-close — only while the modal is open so nested modals keep
  // independent behaviour. Gated on `disableClose` so async work (upload,
  // download, regenerate) can't accidentally dismiss the window.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !disableClose) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, disableClose, onClose]);

  // Body-scroll lock. Increments a global counter on open, decrements on
  // close. Only the first modal to open snapshots the original overflow
  // and only the last to close restores it — keeps layered modals
  // (import-review → dependency) from each other unlocking page scroll
  // out from under the outer modal.
  useEffect(() => {
    if (!open) return;
    if (openModalCount === 0) {
      savedBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    openModalCount++;
    return () => {
      openModalCount--;
      if (openModalCount === 0) {
        document.body.style.overflow = savedBodyOverflow ?? '';
        savedBodyOverflow = null;
      }
    };
  }, [open]);

  // Three-state machine driving entrance + exit fade via CSS transitions
  // (NOT keyframe animations — those re-triggered intermittently when
  // classNames swapped mid-flight, especially under StrictMode).
  //
  //   `mounted` = is the modal in the DOM at all
  //   `visible` = should we be at full opacity / scale-100
  //
  // Entrance:  mounted=true, visible=false  →  rAF tick  →  visible=true
  //            (initial paint at opacity-0 so the transition has a "from"
  //             state to interpolate from)
  // Exit:      visible=false (transition starts immediately)  →  150ms  →
  //            mounted=false (DOM removed)
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      // Wait one frame so the DOM paints with opacity-0, then flip to
      // opacity-100 — that's what kicks off the entrance transition.
      const r = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(r);
    }
    if (!mounted) return;
    setVisible(false);
    const t = setTimeout(() => setMounted(false), CLOSE_ANIMATION_MS);
    return () => clearTimeout(t);
  }, [open, mounted]);

  if (!mounted) return null;
  // `isExiting` here is just for the data-state attribute; the actual
  // visual swap is driven by the `visible` flag below.
  const isExiting = !visible;

  const sizeClass = SIZE_CLASS[size];
  // CardContent already supplies px-4 py-4, so we only add the layout
  // affordances (overflow + flex sizing) here.
  const bodyClass = scrollBody
    ? 'overflow-y-auto flex-1'
    : 'flex-1';
  const maxHeight = scrollBody ? 'max-h-[90vh]' : '';

  // CSS transitions (not keyframe animations) drive the open/close fade.
  // Keyframes were causing intermittent flicker because swapping
  // `animate-in` ↔ `animate-out` mid-flight could re-trigger the source
  // animation in some browsers / under StrictMode's mount-unmount-remount.
  // Transitions interpolate between two states with no restart logic.
  const backdropOpacity = isExiting ? 'opacity-0' : 'opacity-100';
  const cardOpacity = isExiting ? 'opacity-0 scale-95' : 'opacity-100 scale-100';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title ?? ariaLabel}
      data-state={isExiting ? 'closed' : 'open'}
      className={`fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm transition-opacity duration-150 ${backdropOpacity}`}
      onClick={(e) => {
        if (disableClose) return;
        if (!closeOnBackdropClick) return;
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <Card
        data-state={isExiting ? 'closed' : 'open'}
        className={`w-full ${sizeClass} ${maxHeight} flex flex-col transition-all duration-150 ease-out ${cardOpacity} ${className ?? ''}`.trim()}
      >
        {header ?? (
          <CardHeader className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2.5 min-w-0">
              {icon && <div className="shrink-0">{icon}</div>}
              <div className="min-w-0">
                {title && (
                  <h2 className="text-sm font-semibold text-slate-900 truncate" title={title}>
                    {title}
                  </h2>
                )}
                {subtitle && <p className="mt-0.5 text-[11px] text-slate-400">{subtitle}</p>}
              </div>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Close"
              onClick={onClose}
              disabled={disableClose}
            >
              <X className="w-4 h-4" />
            </Button>
          </CardHeader>
        )}

        <CardContent className={bodyClass}>{children}</CardContent>

        {footer && <CardFooter>{footer}</CardFooter>}
      </Card>
    </div>
  );
}
