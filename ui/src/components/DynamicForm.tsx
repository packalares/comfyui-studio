import type { FormInput } from '../types';
import FormField from './FormField';

interface Props {
  inputs: FormInput[];
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
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
 * Document order is preserved within each bucket so authored field
 * adjacency still reads as-intended.
 */
type Bucket = 'full' | 'grid' | 'toggle';
const BUCKET_BY_TYPE: Record<FormInput['type'], Bucket> = {
  textarea: 'full',
  image: 'full',
  audio: 'full',
  video: 'full',
  text: 'grid',
  number: 'grid',
  slider: 'grid',
  select: 'grid',
  toggle: 'toggle',
};

export default function DynamicForm({ inputs, values, onChange }: Props) {
  const handleFieldChange = (id: string, value: unknown) => {
    onChange({ ...values, [id]: value });
  };

  if (inputs.length === 0) {
    return (
      <p className="text-sm text-slate-400 py-4">No parameters for this template.</p>
    );
  }

  const buckets: Record<Bucket, FormInput[]> = { full: [], grid: [], toggle: [] };
  for (const i of inputs) buckets[BUCKET_BY_TYPE[i.type] ?? 'grid'].push(i);

  const renderField = (input: FormInput) => (
    <FormField
      key={input.id}
      input={input}
      value={values[input.id] ?? input.default ?? (input.type === 'toggle' ? false : undefined)}
      onChange={(val) => handleFieldChange(input.id, val)}
    />
  );

  return (
    <div className="space-y-4">
      {buckets.full.length > 0 && (
        <div className="space-y-4">{buckets.full.map(renderField)}</div>
      )}
      {buckets.grid.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-3 gap-y-3">
          {buckets.grid.map(renderField)}
        </div>
      )}
      {buckets.toggle.length > 0 && (
        <div className="space-y-2 pt-2 border-t border-slate-100">
          {buckets.toggle.map(renderField)}
        </div>
      )}
    </div>
  );
}
