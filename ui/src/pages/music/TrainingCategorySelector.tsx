// Category / sub-type picker for the Train tab's Step 0. Ported from
// ace-step-ui's `TrainingCategorySelector.tsx`, rebuilt on comfy's design
// tokens (brand color, border/muted surfaces) instead of the pink-specific
// Tailwind classes ace-step-ui hardcoded.

import {
  Activity, AudioWaveform, Check, CircleDot, Disc, Disc3, Drum, Guitar,
  Heart, Mic, Music, Music2, Piano, Sliders, Waves,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { TrainingCategoryConfig, TrainingCategoryId, TrainingSubType } from './trainingCategories';

const ICONS: Record<string, LucideIcon> = {
  Activity, AudioWaveform, CircleDot, Disc, Disc3, Drum, Guitar, Heart, Mic, Music, Music2, Piano, Sliders, Waves,
};

function resolveIcon(name: string): LucideIcon {
  return ICONS[name] ?? Music;
}

interface TrainingCategorySelectorProps {
  categories: TrainingCategoryConfig[];
  selectedCategory: TrainingCategoryId | null;
  selectedSubType: string | null;
  onSelectCategory: (id: TrainingCategoryId) => void;
  onSelectSubType: (id: string | null) => void;
}

export function TrainingCategorySelector({
  categories, selectedCategory, selectedSubType, onSelectCategory, onSelectSubType,
}: TrainingCategorySelectorProps) {
  const active = categories.find((c) => c.id === selectedCategory) ?? null;

  return (
    <div className="space-y-3">
      <div>
        <h3 className="mb-1 text-xs font-medium text-muted-foreground">Pick a training category</h3>
        <p className="mb-3 text-xs text-muted-foreground">
          Each category tunes preprocessing, auto-labelling and training defaults for you.
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {categories.map((cat) => {
            const Icon = resolveIcon(cat.icon);
            const isActive = cat.id === selectedCategory;
            return (
              <button
                key={cat.id}
                type="button"
                onClick={() => onSelectCategory(cat.id)}
                className={cn(
                  'relative rounded-xl border px-3 py-2.5 text-left transition-colors',
                  isActive ? 'border-brand bg-brand/10' : 'border-border bg-card hover:border-ring',
                )}
              >
                {isActive && <span className="absolute right-1.5 top-1.5 text-brand"><Check className="h-3 w-3" /></span>}
                <div className="flex items-start gap-2">
                  <span className={cn('mt-0.5 shrink-0', isActive ? 'text-brand' : 'text-muted-foreground')}>
                    <Icon className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <div className={cn('truncate text-xs font-semibold', isActive ? 'text-brand' : 'text-foreground')}>
                      {cat.displayName}
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-[11px] leading-tight text-muted-foreground">{cat.description}</p>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {active?.subTypes && active.subTypes.length > 0 && (
        <SubTypePicker subTypes={active.subTypes} selectedSubType={selectedSubType} onSelect={onSelectSubType} />
      )}
    </div>
  );
}

function SubTypePicker({
  subTypes, selectedSubType, onSelect,
}: { subTypes: TrainingSubType[]; selectedSubType: string | null; onSelect: (id: string) => void }) {
  return (
    <div>
      <h4 className="mb-1.5 text-xs font-medium text-muted-foreground">Sub-type</h4>
      <div className="flex flex-wrap gap-1.5">
        {subTypes.map((sub) => {
          const Icon = resolveIcon(sub.icon ?? 'Music');
          const isActive = sub.id === selectedSubType;
          return (
            <button
              key={sub.id}
              type="button"
              onClick={() => onSelect(sub.id)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
                isActive ? 'border-brand bg-brand/15 text-brand' : 'border-border bg-card text-muted-foreground hover:border-ring',
              )}
            >
              <Icon className="h-3 w-3" />
              {sub.displayName}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default TrainingCategorySelector;
