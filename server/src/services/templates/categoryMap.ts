// Single source of truth for mapping a template's category title + mediaType
// down to one of the five Studio buckets. Used by both the import flow
// (when writing fresh disk JSONs) and the route mappers (when projecting
// DB rows back out). Keeping one canonical function here prevents the two
// sites from silently diverging when new synonyms are added.

export type StudioCategory = 'image' | 'video' | 'audio' | '3d' | 'tools';

/**
 * Resolve a Studio category from a template's `mediaType` (preferred when
 * known) and its catalog `category` title (fallback). Both inputs are
 * optional so callers can pass whichever they have.
 *
 *  - mediaType direct hits (`video` / `audio` / `3d`) short-circuit.
 *  - Otherwise the category title is scanned for keywords.
 *  - `image` is the default — keeps the previous behaviour for any
 *    template that doesn't match a more specific bucket.
 */
export function deriveStudioCategory(
  mediaType: string | null | undefined,
  category: string | null | undefined,
): StudioCategory {
  if (mediaType === 'video' || mediaType === 'audio' || mediaType === '3d') return mediaType;
  const t = (category ?? '').toLowerCase();
  if (t.includes('video')) return 'video';
  if (t.includes('audio')) return 'audio';
  if (t.includes('3d')) return '3d';
  if (t.includes('utility') || t.includes('tool') || t.includes('llm')) return 'tools';
  return 'image';
}
