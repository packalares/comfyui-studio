import { useEffect, useState } from 'react';
import { Box } from 'lucide-react';

/**
 * Lazy-loaded `<model-viewer>` wrapper.
 *
 * `@google/model-viewer` registers a custom element (`<model-viewer>`) when
 * its module side-effects run. We dynamic-import it on mount so the ~400 KB
 * of three.js + GLTF machinery doesn't land in the main bundle — only
 * pages that actually display a 3D model pay the cost.
 *
 * The web component is declared globally via module augmentation (see
 * `src/types/model-viewer.d.ts`) so JSX can accept its attributes.
 */

interface Props {
  src: string;
  alt?: string;
  className?: string;
  /** When true, kicks off a slow idle orbit after the model loads. */
  autoRotate?: boolean;
}

export default function ThreeDViewer({ src, alt, className, autoRotate = true }: Props) {
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    import('@google/model-viewer')
      .then(() => { if (!cancelled) setReady(true); })
      .catch(e => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => { cancelled = true; };
  }, []);

  if (err) {
    return (
      <div className={`flex flex-col items-center justify-center gap-2 bg-slate-100 text-slate-500 ${className ?? ''}`}>
        <Box className="w-10 h-10 opacity-40" />
        <p className="text-xs">3D viewer failed to load</p>
        <a
          href={src}
          download
          className="text-xs text-teal-600 underline"
        >Download .glb</a>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className={`flex items-center justify-center bg-slate-50 ${className ?? ''}`}>
        <Box className="w-10 h-10 text-slate-300 animate-pulse" />
      </div>
    );
  }

  // `model-viewer` is a custom element; JSX types come from types/model-viewer.d.ts.
  return (
    <model-viewer
      src={src}
      alt={alt ?? '3D model'}
      camera-controls=""
      {...(autoRotate ? { 'auto-rotate': '' } : {})}
      interaction-prompt="none"
      // `neutral` is model-viewer's built-in studio HDR — gives proper PBR
      // shading even when the GLB has no embedded environment. Without it,
      // untextured meshes read as flat gray silhouettes.
      environment-image="neutral"
      tone-mapping="neutral"
      exposure="1.0"
      shadow-intensity="0.6"
      shadow-softness="0.8"
      style={{ width: '100%', height: '100%', background: '#f8fafc' }}
      className={className}
    />
  );
}
