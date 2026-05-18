// Modal shell for the mask/pad editing UI.
//
// Rendered by the image upload field when the field has maskable='brush' or
// maskable='pad'. Uses AppModal as the backdrop/close primitive and delegates
// the actual widget to MaskCanvas (brush) or PadCanvas (pad).
//
// The modal is mode-driven at v1: field.maskable is the single source of truth
// for which widget to show. If a future template needs dynamic switching based
// on the mode-select value that is handled by the parent passing `currentMode`.

import AppModal from '../modals/AppModal.js';
import MaskCanvas from './MaskCanvas.js';
import PadCanvas, { type PadValues } from './PadCanvas.js';
import type { FormInput } from '../../types/index.js';

export interface MaskSaveState {
  maskDataUrl?: string | null;
  pad?: PadValues & { feathering: number };
}

export interface MaskFieldModalProps {
  field: FormInput;
  imageSrc: string;
  currentMode: 'brush' | 'pad';
  initial?: {
    maskDataUrl?: string;
    pad?: PadValues & { feathering: number };
  };
  onSave: (state: MaskSaveState) => void;
  onClose: () => void;
}

export default function MaskFieldModal({
  field,
  imageSrc,
  currentMode,
  initial,
  onSave,
  onClose,
}: MaskFieldModalProps) {
  const title = currentMode === 'brush'
    ? `Paint mask — ${field.label}`
    : `Set padding — ${field.label}`;

  const subtitle = currentMode === 'brush'
    ? 'Paint the region to regenerate. Painted area = inpaint zone.'
    : 'Drag the edges outward to set how much to extend each side.';

  return (
    <AppModal
      open
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      size="xl"
      scrollBody={false}
      className="h-[85vh]"
    >
      {currentMode === 'brush' ? (
        <MaskCanvas
          imageSrc={imageSrc}
          initialMaskDataUrl={initial?.maskDataUrl}
          onSave={(maskDataUrl) => onSave({ maskDataUrl })}
          onClose={onClose}
        />
      ) : (
        <PadCanvas
          imageSrc={imageSrc}
          initial={initial?.pad}
          onSave={(pad) => onSave({ pad })}
          onClose={onClose}
        />
      )}
    </AppModal>
  );
}
