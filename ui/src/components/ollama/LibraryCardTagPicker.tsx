// Per-Library-card tag picker. Lazy-fetches tags on each dropdown open —
// there's no client cache, but the server caches per-model for 1h so the
// cost is amortised. The picker disables the Pull button until tags arrive.

import { useCallback, useState } from 'react';
import { api, type OllamaTagEntry } from '../../services/comfyui';
import { Spinner } from '../ui/spinner';
import {
  SelectField, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../forms/SelectField';

interface Props {
  modelName: string;
  defaultTag: string;
  selectedTag: string;
  onSelect: (tag: string) => void;
}

export function LibraryCardTagPicker({
  modelName,
  defaultTag,
  selectedTag,
  onSelect,
}: Props) {
  const [tags, setTags] = useState<OllamaTagEntry[] | null>(null);
  const [loading, setLoading] = useState(false);

  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) return;
    setLoading(true);
    api.chat.getLibraryTags(modelName)
      .then(({ tags }) => setTags(tags))
      .catch(() => setTags([]))
      .finally(() => setLoading(false));
  }, [modelName]);

  const value = selectedTag || defaultTag;
  return (
    <SelectField value={value} onValueChange={onSelect} onOpenChange={handleOpenChange}>
      <SelectTrigger className="w-full">
        <SelectValue placeholder="Select tag…" />
      </SelectTrigger>
      <SelectContent>
        {loading && (
          <div className="flex items-center justify-center gap-2 py-2 text-xs text-muted-foreground">
            <Spinner size="sm" />
            Loading tags…
          </div>
        )}
        {!loading && tags === null && (
          // First open hasn't started yet — show the current selection only.
          <SelectItem value={value}>{value}</SelectItem>
        )}
        {!loading && tags && tags.length === 0 && (
          <div className="px-2 py-2 text-xs text-muted-foreground">No tags available.</div>
        )}
        {!loading && tags && tags.map(t => (
          <SelectItem key={t.tag} value={t.tag}>
            <span className="font-mono">{t.tag}</span>
            <span className="ml-2 text-[11px] text-muted-foreground">
              {[t.size, t.contextLength && `${t.contextLength} ctx`, t.input]
                .filter(Boolean).join(' · ')}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </SelectField>
  );
}
