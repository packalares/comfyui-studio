// CivitAI filter sidebar — multi-select chips for Type + Base model, single
// selects for Period + Sort, and an NSFW toggle. Vocabulary is fetched from
// /civitai/models/facets so chip lists are never hardcoded here; until the
// facet response arrives a skeleton row stands in for the chips.

import { useCallback } from 'react';
import { Spinner } from './ui/spinner';
import { Checkbox } from './ui/checkbox';
import {
  SelectField,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './forms/SelectField';
import type { CivitaiFacetsResponse } from '../services/comfyui';

interface CivitaiFilterSidebarProps {
  facets: CivitaiFacetsResponse | null;
  loading: boolean;
  types: string[];
  baseModels: string[];
  nsfw: boolean;
  period: string;
  sort: string;
  onTypesChange:      (next: string[]) => void;
  onBaseModelsChange: (next: string[]) => void;
  onNsfwChange:       (next: boolean) => void;
  onPeriodChange:     (next: string) => void;
  onSortChange:       (next: string) => void;
}

function toggleIn(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

function ChipRow({
  values, selected, onToggle, ariaLabel,
}: {
  values: string[];
  selected: string[];
  onToggle: (value: string) => void;
  ariaLabel: string;
}) {
  if (values.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground italic">
        No options available — upstream returned nothing.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label={ariaLabel}>
      {values.map((v) => {
        const active = selected.includes(v);
        return (
          <button
            key={v}
            type="button"
            onClick={() => onToggle(v)}
            aria-pressed={active}
            className={`text-[11px] px-2 py-1 rounded-full ring-1 ring-inset transition-colors ${
              active
                ? 'ring-brand bg-brand/15 text-brand'
                : 'ring-border bg-card hover:bg-muted text-muted-foreground hover:text-foreground'
            }`}
          >
            {v}
          </button>
        );
      })}
    </div>
  );
}

function SkeletonChips() {
  return (
    <div className="flex flex-wrap gap-1.5">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-6 w-16 rounded-full bg-muted animate-pulse" />
      ))}
    </div>
  );
}

export default function CivitaiFilterSidebar(props: CivitaiFilterSidebarProps) {
  const {
    facets, loading, types, baseModels, nsfw, period, sort,
    onTypesChange, onBaseModelsChange, onNsfwChange, onPeriodChange, onSortChange,
  } = props;
  const toggleType = useCallback(
    (v: string) => onTypesChange(toggleIn(types, v)),
    [types, onTypesChange],
  );
  const toggleBase = useCallback(
    (v: string) => onBaseModelsChange(toggleIn(baseModels, v)),
    [baseModels, onBaseModelsChange],
  );
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          CivitAI filters
        </h3>
        {loading && <Spinner size="xs" />}
      </div>

      <div>
        <label className="field-label mb-1.5 block">Type</label>
        {facets ? (
          <ChipRow values={facets.types} selected={types} onToggle={toggleType} ariaLabel="Type" />
        ) : (
          <SkeletonChips />
        )}
      </div>

      <div>
        <label className="field-label mb-1.5 block">Base model</label>
        {facets ? (
          <ChipRow
            values={facets.baseModels}
            selected={baseModels}
            onToggle={toggleBase}
            ariaLabel="Base model"
          />
        ) : (
          <SkeletonChips />
        )}
      </div>

      <div>
        <label className="field-label mb-1.5 block">Period</label>
        <SelectField value={period} onValueChange={onPeriodChange}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {(facets?.periods ?? []).map((p) => (
              <SelectItem key={p} value={p}>{p}</SelectItem>
            ))}
          </SelectContent>
        </SelectField>
      </div>

      <div>
        <label className="field-label mb-1.5 block">Sort</label>
        <SelectField value={sort} onValueChange={onSortChange}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {(facets?.sorts ?? []).map((s) => (
              <SelectItem key={s} value={s}>{s}</SelectItem>
            ))}
          </SelectContent>
        </SelectField>
      </div>

      <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none hover:text-foreground">
        <Checkbox checked={nsfw} onCheckedChange={(v) => onNsfwChange(v === true)} />
        Show NSFW
      </label>
    </div>
  );
}
