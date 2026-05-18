// Brush-paint mask canvas for inpainting templates.
//
// Renders the source image on a base canvas and a transparent overlay on a
// second canvas where the user paints the region to regenerate. The overlay
// uses semitransparent red so the paint is visible without hiding the image.
//
// The pixel grid of both canvases stays at the image's native resolution so
// the exported mask aligns 1:1 when ComfyUI reads it. Visual scaling to fit
// the container is done via CSS transform.

import { useRef, useState, useEffect, useCallback } from 'react';
import { Slider } from '../ui/slider';
import { Button } from '../ui/button';

export interface MaskCanvasProps {
  imageSrc: string;
  initialMaskDataUrl?: string;
  onSave: (maskDataUrl: string | null) => void;
  onClose: () => void;
}

// Paint colour is FULLY opaque on the underlying canvas; the translucent
// look comes from CSS opacity on the mask layer. Painting with semi-alpha
// would cause overlapping strokes to accumulate opacity (the same pixel
// repainted is darker), giving "more transparent where I went fast, fully
// red where I went slow" UX. Full alpha + CSS opacity = uniform appearance
// no matter how many times a pixel is crossed, and the exported mask comes
// out as a clean binary 0/1 which is what ComfyUI's LoadImage.MASK wants.
const PAINT_COLOR = 'rgba(255, 0, 0, 1)';
const MASK_CSS_OPACITY = 0.5;

export default function MaskCanvas({ imageSrc, initialMaskDataUrl, onSave, onClose }: MaskCanvasProps) {
  const baseRef = useRef<HTMLCanvasElement>(null);
  const maskRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [brushSize, setBrushSize] = useState(35);
  const [mode, setMode] = useState<'paint' | 'erase'>('paint');
  const [scale, setScale] = useState(1);
  const [imgSize, setImgSize] = useState({ w: 0, h: 0 });
  // Cursor preview position in NATIVE canvas coordinates. Null while the
  // pointer is outside the canvas. Used to render a brush-size circle so
  // the user can see exactly where + how big their next stroke will be.
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null);
  const isPainting = useRef(false);
  const lastPos = useRef<{ x: number; y: number } | null>(null);

  // Load image onto base canvas and seed the mask canvas.
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      const { naturalWidth: w, naturalHeight: h } = img;
      setImgSize({ w, h });

      // Draw background image at native resolution.
      const base = baseRef.current;
      if (base) {
        base.width = w;
        base.height = h;
        const ctx = base.getContext('2d');
        ctx?.drawImage(img, 0, 0);
      }

      // Initialise mask canvas with prior mask if provided.
      const mask = maskRef.current;
      if (mask) {
        mask.width = w;
        mask.height = h;
        if (initialMaskDataUrl) {
          const prior = new Image();
          prior.onload = () => mask.getContext('2d')?.drawImage(prior, 0, 0);
          prior.src = initialMaskDataUrl;
        }
      }
    };
    img.src = imageSrc;
  }, [imageSrc, initialMaskDataUrl]);

  // Compute CSS scale so the canvas fits the container without distorting.
  useEffect(() => {
    if (!imgSize.w || !imgSize.h || !containerRef.current) return;
    const { clientWidth: cw, clientHeight: ch } = containerRef.current;
    if (!cw || !ch) return;
    const s = Math.min(1, cw / imgSize.w, ch / imgSize.h);
    setScale(s);
  }, [imgSize]);

  const getCanvasPos = useCallback((e: React.PointerEvent): { x: number; y: number } => {
    const canvas = maskRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    // getBoundingClientRect reflects the CSS transform scale, so divide by
    // scale to convert from display coords to native canvas coords.
    const x = (e.clientX - rect.left) / scale;
    const y = (e.clientY - rect.top) / scale;
    return { x, y };
  }, [scale]);

  const drawStroke = useCallback((from: { x: number; y: number } | null, to: { x: number; y: number }) => {
    const canvas = maskRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.globalCompositeOperation = mode === 'erase' ? 'destination-out' : 'source-over';
    ctx.fillStyle = PAINT_COLOR;
    ctx.strokeStyle = PAINT_COLOR;
    ctx.lineWidth = brushSize;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    if (from) {
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    }
    // Always draw a dot at the current point so single clicks register.
    ctx.beginPath();
    ctx.arc(to.x, to.y, brushSize / 2, 0, Math.PI * 2);
    ctx.fill();
  }, [mode, brushSize]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    isPainting.current = true;
    const pos = getCanvasPos(e);
    lastPos.current = pos;
    drawStroke(null, pos);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, [getCanvasPos, drawStroke]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const pos = getCanvasPos(e);
    setCursorPos(pos);
    if (!isPainting.current) return;
    drawStroke(lastPos.current, pos);
    lastPos.current = pos;
  }, [getCanvasPos, drawStroke]);

  const stopPainting = useCallback(() => {
    isPainting.current = false;
    lastPos.current = null;
  }, []);

  const onPointerLeave = useCallback(() => {
    stopPainting();
    setCursorPos(null);
  }, [stopPainting]);

  const handleClear = () => {
    const canvas = maskRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  };

  const handleInvert = () => {
    const canvas = maskRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // Swap: painted (opaque) ↔ transparent. Draw a solid rectangle then
    // use destination-out to flip where paint was, then restore the inverse.
    const { width, height } = canvas;
    const imageData = ctx.getImageData(0, 0, width, height);
    const { data } = imageData;
    for (let i = 0; i < data.length; i += 4) {
      // Flip alpha: previously-painted (>0) → 0, previously-clear (0) → 255.
      // The mask stores binary alpha internally; CSS opacity provides the
      // semitransparent on-screen look without affecting the export.
      data[i + 3] = data[i + 3] > 0 ? 0 : 255;
      data[i] = 255; data[i + 1] = 0; data[i + 2] = 0;
    }
    ctx.putImageData(imageData, 0, 0);
  };

  const handleSave = () => {
    const canvas = maskRef.current;
    if (!canvas) { onSave(null); return; }
    onSave(canvas.toDataURL('image/png'));
  };

  const displayW = imgSize.w * scale;
  const displayH = imgSize.h * scale;

  return (
    <div className="flex flex-col gap-3 h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-[11px] text-muted-foreground">Brush size</span>
        <div className="w-28">
          <Slider value={[brushSize]} onValueChange={([v]) => setBrushSize(v)} min={1} max={100} step={1} />
        </div>
        <span className="text-[11px] tabular-nums text-foreground w-7">{brushSize}px</span>
        <div className="flex items-center gap-1 ml-auto">
          <Button
            type="button" size="sm" variant={mode === 'paint' ? 'default' : 'outline'}
            onClick={() => setMode('paint')}
          >Paint</Button>
          <Button
            type="button" size="sm" variant={mode === 'erase' ? 'default' : 'outline'}
            onClick={() => setMode('erase')}
          >Erase</Button>
          <Button type="button" size="sm" variant="outline" onClick={handleInvert}>Invert</Button>
          <Button type="button" size="sm" variant="outline" onClick={handleClear}>Clear</Button>
        </div>
      </div>

      {/* Canvas area */}
      <div ref={containerRef} className="flex-1 overflow-hidden flex items-center justify-center bg-muted/50 rounded-lg min-h-0">
        <div style={{ position: 'relative', width: displayW, height: displayH }}>
          <canvas
            ref={baseRef}
            style={{ position: 'absolute', top: 0, left: 0, width: displayW, height: displayH }}
          />
          <canvas
            ref={maskRef}
            style={{
              position: 'absolute', top: 0, left: 0,
              width: displayW, height: displayH,
              // Hide the system cursor — we render our own brush-size circle
              // below so the user can see what their next stroke will cover.
              cursor: 'none',
              // Visual translucency only. The underlying canvas keeps full
              // alpha; this just makes the paint look red-tinted on screen.
              opacity: MASK_CSS_OPACITY,
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={stopPainting}
            onPointerLeave={onPointerLeave}
          />
          {/* Brush-size cursor preview. Rendered in DISPLAY coordinates
              (cursorPos is native, scale converts) so it tracks 1:1 with
              the pointer regardless of the canvas's CSS scale. */}
          {cursorPos && (
            <div
              aria-hidden
              className="pointer-events-none absolute rounded-full"
              style={{
                width: brushSize * scale,
                height: brushSize * scale,
                left: cursorPos.x * scale - (brushSize * scale) / 2,
                top: cursorPos.y * scale - (brushSize * scale) / 2,
                border: mode === 'erase'
                  ? '2px dashed rgba(0, 0, 0, 0.65)'
                  : '2px solid rgba(255, 0, 0, 0.85)',
                boxShadow: '0 0 0 1px rgba(255, 255, 255, 0.55)',
              }}
            />
          )}
        </div>
      </div>

      {/* Footer actions */}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
        <Button type="button" onClick={handleSave}>Apply mask</Button>
      </div>
    </div>
  );
}
