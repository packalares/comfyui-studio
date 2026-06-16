// CameraSettingsModal — 4-column picker (Camera / Lens / Focal Length / Aperture).
//
// Wraps the app-standard `AppModal` primitive (same chrome as
// MediaLibraryModal / ImportWorkflowModal etc.) so the Esc/backdrop/scroll
// gestures match every other modal. Option data lives in
// `data/cameraOptions.json` so lists can grow without touching this file.
//
// Selection is fully controlled — parent holds the four chosen ids, this
// modal only emits the next state on Continue.

import { useEffect, useMemo, useState } from 'react';
import { Aperture, Camera, Circle, Focus } from 'lucide-react';
import { Button } from '../ui/button';
import AppModal from './AppModal';
import cameraOptions from '../../data/cameraOptions.json';

export interface CameraOption {
  id: string;
  label: string;
}

export interface CameraSelection {
  cameraId: string | null;
  lensId: string | null;
  focalLengthId: string | null;
  apertureId: string | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: CameraSelection;
  onApply: (next: CameraSelection) => void;
}

type ColumnKey = 'camera' | 'lens' | 'focalLength' | 'aperture';

const COLUMNS: Array<{ key: ColumnKey; title: string; idField: keyof CameraSelection; Icon: React.ElementType; compact?: boolean }> = [
  { key: 'camera',      title: 'Camera',       idField: 'cameraId',      Icon: Camera },
  { key: 'lens',        title: 'Lens',         idField: 'lensId',        Icon: Aperture },
  { key: 'focalLength', title: 'Focal Length', idField: 'focalLengthId', Icon: Focus },
  { key: 'aperture',    title: 'Aperture',     idField: 'apertureId',    Icon: Circle, compact: true },
];

export default function CameraSettingsModal({ open, onOpenChange, value, onApply }: Props) {
  const [draft, setDraft] = useState<CameraSelection>(value);

  // Reset draft to the live value every time the modal opens, so cancelling
  // (close without Continue) is non-destructive.
  useEffect(() => {
    if (open) setDraft(value);
  }, [open, value]);

  const lists = useMemo(() => ({
    camera:      cameraOptions.camera      as CameraOption[],
    lens:        cameraOptions.lens        as CameraOption[],
    focalLength: cameraOptions.focalLength as CameraOption[],
    aperture:    cameraOptions.aperture    as CameraOption[],
  }), []);

  const handleApply = () => {
    onApply(draft);
    onOpenChange(false);
  };

  return (
    <AppModal
      open={open}
      onClose={() => onOpenChange(false)}
      title="Camera settings"
      size="xl"
      scrollBody
      closeOnBackdropClick
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleApply}>Continue</Button>
        </div>
      }
    >
      <div className="grid grid-cols-4 gap-4 py-1">
        {COLUMNS.map(col => {
          const items = lists[col.key];
          const selectedId = draft[col.idField];
          return (
            <div key={col.key} className="flex min-w-0 flex-col gap-1.5">
              <div className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {col.title}
              </div>
              {items.map(opt => {
                const isSelected = selectedId === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setDraft(d => ({ ...d, [col.idField]: opt.id }))}
                    className={[
                      'group flex w-full items-center justify-between gap-2 rounded-md border text-left transition',
                      col.compact ? 'h-10 px-3' : 'h-11 px-3.5',
                      isSelected
                        ? 'border-brand bg-brand/10 text-foreground ring-1 ring-brand/40'
                        : 'border-border/60 bg-card hover:bg-accent/50 text-foreground/90',
                    ].join(' ')}
                  >
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {opt.label}
                    </span>
                    {col.compact ? (
                      <span
                        className={[
                          'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2',
                          isSelected ? 'border-brand' : 'border-border',
                        ].join(' ')}
                      >
                        {isSelected && <span className="h-2 w-2 rounded-full bg-brand" />}
                      </span>
                    ) : (
                      <col.Icon
                        className={[
                          'h-4 w-4 shrink-0',
                          isSelected ? 'text-brand' : 'text-muted-foreground',
                        ].join(' ')}
                      />
                    )}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </AppModal>
  );
}

/** Resolve a CameraSelection into displayable labels. Returns null fields
 *  when the corresponding id is unset, so callers can render placeholders. */
export function resolveCameraLabels(sel: CameraSelection): {
  camera: string | null;
  lens: string | null;
  focalLength: string | null;
  aperture: string | null;
} {
  const find = (list: CameraOption[], id: string | null) =>
    id == null ? null : list.find(o => o.id === id)?.label ?? null;
  return {
    camera:      find(cameraOptions.camera      as CameraOption[], sel.cameraId),
    lens:        find(cameraOptions.lens        as CameraOption[], sel.lensId),
    focalLength: find(cameraOptions.focalLength as CameraOption[], sel.focalLengthId),
    aperture:    find(cameraOptions.aperture    as CameraOption[], sel.apertureId),
  };
}
