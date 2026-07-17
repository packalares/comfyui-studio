import { useEffect, useRef, useState } from 'react';
import { ImageIcon } from 'lucide-react';

/** Preset card shape — mirrors the server's
 *  `/api/template-bundle/:templateName` `presets[]` entry. */
export type PresetCard = {
  id: string;
  title: string;
  description?: string;
  previewUrl?: string;
  published?: boolean;
  tool?: string;
};

/** Shape of the `/api/template-presets/:parent/:presetId` 200 response.
 *  `settings` is the Pikaso-style block the import hook stored on disk —
 *  forwarded verbatim so the host can pick fields off it (prompt,
 *  aspect_ratio, etc.) without re-querying. `card` is the matching display
 *  card from the DB column (null when the column has been cleared). */
export interface PresetApplyPayload {
  id: string;
  parent: string;
  settings: Record<string, unknown>;
  card: PresetCard | null;
}

interface PresetGridProps {
  presets: PresetCard[];
  /** Parent template name — used to build the apply endpoint URL. */
  parentTemplateName: string;
  /** Called after a click successfully resolves the preset's settings off
   *  the server. The host typically pushes this down to the active Builder
   *  so the form fills in. Not fired on HTTP errors. */
  onPresetApply?: (payload: PresetApplyPayload) => void;
}

/** Grid of preset thumbnails that renders below the condensed
 *  "Ready when you are" header. Designed for 75+ entries — every
 *  thumbnail is gated behind an IntersectionObserver so the page
 *  doesn't burst-fire 75 image requests on mount. */
export function PresetGrid({ presets, parentTemplateName, onPresetApply }: PresetGridProps) {
  if (presets.length === 0) return null;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
      {presets.map(preset => (
        <PresetCardTile
          key={preset.id}
          preset={preset}
          parentTemplateName={parentTemplateName}
          onPresetApply={onPresetApply}
        />
      ))}
    </div>
  );
}

interface PresetCardTileProps {
  preset: PresetCard;
  parentTemplateName: string;
  onPresetApply?: (payload: PresetApplyPayload) => void;
}

/** Single preset tile. Square thumbnail, gradient title strip at
 *  the bottom, gated lazy-load via IntersectionObserver — see
 *  `MediaLibraryModal` for the prior art (native `loading="lazy"`
 *  ignores overflow:scroll containers, which is why we DIY it). */
function PresetCardTile({ preset, parentTemplateName, onPresetApply }: PresetCardTileProps) {
  const tileRef = useRef<HTMLButtonElement>(null);
  const [shouldLoad, setShouldLoad] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);

  useEffect(() => {
    if (shouldLoad) return;
    const el = tileRef.current;
    if (!el) return;
    // rootMargin: prefetch a row early so the first scroll feels snappy
    // without burning bandwidth on the bottom of a 75+ list.
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setShouldLoad(true);
            obs.disconnect();
            break;
          }
        }
      },
      { rootMargin: '200px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [shouldLoad]);

  // Append a width hint so the thumbnail API resizes server-side
  // instead of sending the full-resolution PNG over the wire.
  const previewSrc = preset.previewUrl
    ? `${preset.previewUrl}${preset.previewUrl.includes('?') ? '&' : '?'}w=320`
    : null;

  const handleClick = () => {
    const url =
      '/api/template-presets/' +
      encodeURIComponent(parentTemplateName) +
      '/' +
      encodeURIComponent(preset.id);
    fetch(url)
      .then(async res => {
        if (!res.ok) {
          // eslint-disable-next-line no-console
          console.warn('[PresetGrid] apply failed', preset.id, res.status);
          return;
        }
        const payload = (await res.json()) as PresetApplyPayload;
        onPresetApply?.(payload);
      })
      .catch(err => {
        // eslint-disable-next-line no-console
        console.warn('[PresetGrid] apply error', preset.id, err);
      });
  };

  return (
    <button
      ref={tileRef}
      type="button"
      onClick={handleClick}
      aria-label={preset.title}
      className="group relative block aspect-square w-full overflow-hidden rounded-lg bg-muted ring-1 ring-border/60 hover:ring-border transition-all hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
    >
      {previewSrc && shouldLoad && !imgFailed ? (
        <img
          src={previewSrc}
          alt=""
          decoding="async"
          onError={() => setImgFailed(true)}
          className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
        />
      ) : (
        // Placeholder square so the layout stays stable while the
        // tile is below the fold (or the preview is missing).
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-muted via-muted/70 to-secondary/40 text-muted-foreground">
          <ImageIcon className="h-7 w-7 opacity-50" />
        </div>
      )}

      {/* Slide-up overlay. Same effect as a "slide title + description up
          from below" — except the panel starts partially translated so the
          title block stays peeking at the bottom of the tile. On hover the
          panel slides fully into view, revealing the description above the
          title. Height-agnostic via percent translate so it works whether
          the description ends up 1, 2, or 3 lines. */}
      <div
        className={[
          'pointer-events-none absolute inset-x-0 bottom-0',
          'translate-y-[50%] group-hover:translate-y-0',
          'group-focus-visible:translate-y-0',
          'transition-transform duration-300 ease-out',
          'bg-gradient-to-t from-black/85 via-black/65 to-black/25',
        ].join(' ')}
      >
        <p className="px-3 pt-3 pb-1 text-left text-xs font-semibold text-white drop-shadow-sm line-clamp-2">
          {preset.title}
        </p>
        {preset.description ? (
          <p className="px-3 pt-1 pb-3 text-left text-[11px] leading-snug text-white/90 line-clamp-3">
            {preset.description}
          </p>
        ) : null}
      </div>
    </button>
  );
}

export default PresetGrid;
