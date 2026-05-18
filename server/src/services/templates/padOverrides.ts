// Pad-mode override injection for ImagePadForOutpaint nodes.
//
// When the user sets pad amounts in the UI's drag-edge picker, the values
// arrive as `pad_<fieldId>_<dim>` keys in the form inputs. This module
// maps those keys onto the ImagePadForOutpaint node's widget inputs before
// workflowToApiPrompt converts the workflow to an API prompt.

// Widget names as ComfyUI expects them on ImagePadForOutpaint.
const PAD_WIDGET_MAP: Record<string, string> = {
  left: 'left',
  top: 'top',
  right: 'right',
  bottom: 'bottom',
  feathering: 'feathering',
};

interface PadableField {
  id: string;
  maskable?: Array<{ kind: 'brush' | 'pad'; requiresMode?: string }>;
  padTargetNodeId?: string;
}

/**
 * For each image field whose `maskable` array includes a 'pad' entry and that
 * has a `padTargetNodeId`, look for `pad_<fieldId>_<dim>` entries in
 * `rawInputs` and write them into `nodeOverrides` under the target node id.
 * Runs BEFORE workflowToApiPrompt so the pad values reach the ComfyUI prompt.
 *
 * Mode-aware safety: when the active subgraph for outpaint is bypassed (the
 * mode-select on the UI side flips it to `mode: 4`), ComfyUI skips the
 * ImagePadForOutpaint node entirely, so writing its widgets is a harmless
 * no-op. That's why this function doesn't need to consult the active mode.
 */
export function applyPadOverrides(
  nodeOverrides: Record<string, Record<string, unknown>>,
  formInputs: PadableField[],
  rawInputs: Record<string, unknown>,
): void {
  for (const field of formInputs) {
    const hasPadKind = field.maskable?.some(m => m.kind === 'pad') ?? false;
    if (!hasPadKind || !field.padTargetNodeId) continue;
    const prefix = `pad_${field.id}_`;
    for (const [dim, widgetName] of Object.entries(PAD_WIDGET_MAP)) {
      const key = `${prefix}${dim}`;
      const val = rawInputs[key];
      if (val === undefined || val === null) continue;
      const numVal = typeof val === 'number' ? val : Number(val);
      if (Number.isNaN(numVal)) continue;
      if (!nodeOverrides[field.padTargetNodeId]) nodeOverrides[field.padTargetNodeId] = {};
      nodeOverrides[field.padTargetNodeId][widgetName] = numVal;
    }
  }
}
