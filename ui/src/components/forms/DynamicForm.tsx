import type { FormInput } from '../../types';
import FormField from './FormField';
import { SelectField, SelectContent, SelectItem, SelectTrigger, SelectValue } from './SelectField';

interface Props {
  inputs: FormInput[];
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
  errorNodeIds?: string[];
}

/**
 * Bucket inputs by width class so the form stops looking like a single
 * long column of oversized fields. Matches the Advanced Settings grouping:
 *
 *   full   → textareas + image/audio/video uploads (need horizontal room).
 *   grid   → text / number / slider / select / seed — the "short" inputs
 *            render 2-up on md+, 1-up on mobile.
 *   toggle → toggles pack 3-up on md+, 2-up on mobile.
 *
 * mode-select renders outside the bucket system (always first, full-width).
 * bypass-toggle renders in the toggle bucket.
 *
 * Document order is preserved within each bucket so authored field
 * adjacency still reads as-intended.
 */
type Bucket = 'full' | 'grid' | 'toggle';
const BUCKET_BY_TYPE: Record<string, Bucket> = {
  textarea: 'full',
  image: 'full',
  audio: 'full',
  video: 'full',
  text: 'grid',
  number: 'grid',
  slider: 'grid',
  select: 'grid',
  toggle: 'toggle',
  'bypass-toggle': 'toggle',
};

export default function DynamicForm({ inputs, values, onChange, errorNodeIds }: Props) {
  const handleFieldChange = (id: string, value: unknown) => {
    // Pad-mode image fields return an object with `_padOverrides` carrying
    // sibling keys (pad_<id>_left etc.) to merge into form state alongside
    // the main image value. This avoids threading a multi-update callback
    // all the way through the field component hierarchy.
    if (value && typeof value === 'object' && '_padOverrides' in (value as Record<string, unknown>)) {
      const { _padOverrides, ...imageVal } = value as Record<string, unknown>;
      onChange({ ...values, [id]: imageVal, ...((_padOverrides as Record<string, unknown>) ?? {}) });
      return;
    }
    onChange({ ...values, [id]: value });
  };

  if (inputs.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-4">No parameters for this template.</p>
    );
  }

  const errorNodeSet = errorNodeIds && errorNodeIds.length > 0 ? new Set(errorNodeIds) : null;

  // Determine the active mode so modeRequired-tagged fields can be filtered.
  const modeSelectField = inputs.find(i => i.type === 'mode-select');
  const activeMode = modeSelectField
    ? ((values[modeSelectField.id] as string | undefined) ?? (modeSelectField.default as string | undefined))
    : undefined;

  // Separate mode-select from the rest; filter modeRequired fields.
  const regularInputs = inputs.filter(i => {
    if (i.type === 'mode-select') return false;
    if (i.modeRequired === undefined) return true;
    if (!activeMode) return true;
    const required = Array.isArray(i.modeRequired) ? i.modeRequired : [i.modeRequired];
    return required.includes(activeMode);
  });

  const buckets: Record<Bucket, FormInput[]> = { full: [], grid: [], toggle: [] };
  for (const i of regularInputs) buckets[BUCKET_BY_TYPE[i.type] ?? 'grid'].push(i);

  const renderField = (input: FormInput) => (
    <FormField
      key={input.id}
      input={input}
      value={values[input.id] ?? input.default ?? (input.type === 'toggle' || input.type === 'bypass-toggle' ? false : undefined)}
      onChange={(val) => handleFieldChange(input.id, val)}
      invalid={
        errorNodeSet !== null &&
        ((input.bindNodeId !== undefined && errorNodeSet.has(input.bindNodeId)) ||
          (input.nodeId !== undefined && errorNodeSet.has(String(input.nodeId))))
      }
      // Thread the active mode-select value down so image fields can pick
      // the matching mask-kind entry (brush vs pad) when the template has
      // multiple pipelines. Undefined for templates without a mode-select.
      activeMode={activeMode}
    />
  );

  return (
    <div className="space-y-4">
      {/* Mode selector — renders above all other fields when present. */}
      {modeSelectField && (
        <div>
          <p className="text-[11px] font-medium text-foreground mb-1">{modeSelectField.label}</p>
          <SelectField
            value={(values[modeSelectField.id] as string | undefined) ?? (modeSelectField.default as string | undefined) ?? ''}
            onValueChange={(val) => handleFieldChange(modeSelectField.id, val)}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select mode…" />
            </SelectTrigger>
            <SelectContent>
              {(modeSelectField.options ?? []).map(opt => (
                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
              ))}
            </SelectContent>
          </SelectField>
        </div>
      )}
      {buckets.full.length > 0 && (
        <div className="space-y-4">{buckets.full.map(renderField)}</div>
      )}
      {buckets.grid.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-3 gap-y-3">
          {buckets.grid.map(renderField)}
        </div>
      )}
      {buckets.toggle.length > 0 && (
        <div className="space-y-2 pt-2 border-t">
          {buckets.toggle.map(renderField)}
        </div>
      )}
    </div>
  );
}
