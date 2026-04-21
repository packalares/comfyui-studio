// Thin confirmation dialog built on `AppModal`. Replaces the ad-hoc
// AlertDialog call-sites that were scattered across the app — Gallery's
// delete-confirm and import-from-history confirm are the first users.
//
// Parents pass `onConfirm`; the dialog tracks an internal spinner so the
// caller can keep the prop surface minimal. When the caller already owns
// a `busy` flag (e.g. DependencyModal's isAnyActive) it can pass it in
// and we'll honour that instead.

import { useCallback, useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import AppModal from './AppModal';

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  confirmTone?: 'primary' | 'danger';
  cancelLabel?: string;
  onConfirm: () => void | Promise<void>;
  /** When provided, overrides the internal spinner state. */
  busy?: boolean;
  /** Optional extra body content (error banner, list, etc.). */
  children?: ReactNode;
}

export default function ConfirmDialog(props: ConfirmDialogProps): JSX.Element {
  const {
    open,
    onClose,
    title,
    description,
    confirmLabel = 'Confirm',
    confirmTone = 'primary',
    cancelLabel = 'Cancel',
    onConfirm,
    busy: busyProp,
    children,
  } = props;

  const [internalBusy, setInternalBusy] = useState(false);
  const busy = busyProp ?? internalBusy;

  const handleConfirm = useCallback(async (): Promise<void> => {
    if (busy) return;
    if (busyProp === undefined) setInternalBusy(true);
    try {
      await onConfirm();
    } finally {
      if (busyProp === undefined) setInternalBusy(false);
    }
  }, [busy, busyProp, onConfirm]);

  const confirmClass = confirmTone === 'danger'
    ? 'btn-primary bg-red-600 hover:bg-red-700 focus:ring-red-500'
    : 'btn-primary';

  return (
    <AppModal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      scrollBody={false}
      disableClose={busy}
      footer={
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            className="btn-secondary"
            onClick={onClose}
            disabled={busy}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={confirmClass}
            onClick={() => void handleConfirm()}
            disabled={busy}
          >
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      }
    >
      {description && (
        <p className="text-sm text-slate-600">{description}</p>
      )}
      {children}
    </AppModal>
  );
}
