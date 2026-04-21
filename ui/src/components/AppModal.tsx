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

// Matches the `duration-150` class on the panel's exit animation below.
// Keep in sync if the class changes.
const CLOSE_ANIMATION_MS = 150;

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
   * from their buttons. Disables: backdrop click, Esc key, X button.
   */
  disableClose?: boolean;
  /** Override header entirely (icon/title/subtitle ignored). Includes the X. */
  header?: ReactNode;
  /** Footer slot — typically a `.btn-group` or `.flex` of buttons. */
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

  // Two-phase mount so we can play an exit animation before React unmounts
  // us. `mounted` controls DOM presence; `exiting` flips on while the fade-
  // out runs. The upstream `open` prop is the source of truth — we follow
  // it with a delayed unmount rather than overriding it.
  const [mounted, setMounted] = useState(open);
  const [exiting, setExiting] = useState(false);
  useEffect(() => {
    if (open) {
      setMounted(true);
      setExiting(false);
      return;
    }
    if (!mounted) return;
    setExiting(true);
    const t = setTimeout(() => {
      setMounted(false);
      setExiting(false);
    }, CLOSE_ANIMATION_MS);
    return () => clearTimeout(t);
  }, [open, mounted]);

  if (!mounted) return null;

  const sizeClass = SIZE_CLASS[size];
  const bodyClass = scrollBody
    ? 'overflow-y-auto p-4 flex-1'
    : 'p-4 flex-1';
  const maxHeight = scrollBody ? 'max-h-[90vh]' : '';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title ?? ariaLabel}
      className={`modal-overlay bg-slate-900/40 backdrop-blur-sm ${
        exiting
          ? 'animate-out fade-out-0 duration-150'
          : 'animate-in fade-in-0 duration-150'
      }`}
      onClick={(e) => {
        if (disableClose) return;
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`w-full ${sizeClass} panel ${maxHeight} flex flex-col ${
          exiting
            ? 'animate-out fade-out-0 zoom-out-95 duration-150'
            : 'animate-in fade-in-0 zoom-in-95 duration-200'
        } ${className ?? ''}`.trim()}
      >
        {header ?? (
          <div className="panel-header flex items-start justify-between gap-3">
            <div className="flex items-start gap-2.5 min-w-0">
              {icon && <div className="shrink-0">{icon}</div>}
              <div className="min-w-0">
                {title && (
                  <h2 className="panel-header-title truncate" title={title}>
                    {title}
                  </h2>
                )}
                {subtitle && <p className="panel-header-desc">{subtitle}</p>}
              </div>
            </div>
            <button
              type="button"
              aria-label="Close"
              className="btn-icon"
              onClick={onClose}
              disabled={disableClose}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        <div className={bodyClass}>{children}</div>

        {footer && <div className="panel-footer">{footer}</div>}
      </div>
    </div>
  );
}
