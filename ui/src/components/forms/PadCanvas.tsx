// Drag-edges pad picker for outpainting templates.
//
// Renders the source image at ~60% of the available area with empty padded
// zones around it. Four drag handles on each edge allow the user to set
// the pixel padding for left/top/right/bottom. A "Same on all sides" toggle
// links all four values. Feathering is a plain number input below the canvas.
//
// Drag state is tracked via pointer events on the canvas itself rather than
// separate handle elements — the hit-test is purely geometric.

import { useRef, useState, useEffect, useCallback } from 'react';
import { Switch } from '../ui/switch';
import { Button } from '../ui/button';

export interface PadValues {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PadCanvasProps {
  imageSrc: string;
  initial?: PadValues;
  onSave: (pad: PadValues & { feathering: number }) => void;
  onClose: () => void;
}

// Start with NO extension. The user sees their image at full size and drags
// any edge outward to grow that side. Default of 200 made the image look
// tiny inside a sea of checkerboard, which obscures what's happening.
const DEFAULT_PAD = 0;
const DEFAULT_FEATHER = 40;
const HANDLE_HIT = 16; // px radius for edge-drag hit-test (slightly larger for grab affordance)
const CHECKERBOARD_SIZE = 8; // px per checker square
// Fraction of the canvas the total layout (image + pads) is allowed to fill.
// Leaves a comfortable margin so edge handles aren't clipped at the viewport.
const FIT_FRACTION = 0.88;

type Edge = 'left' | 'top' | 'right' | 'bottom';

export default function PadCanvas({ imageSrc, initial, onSave, onClose }: PadCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  const [pad, setPad] = useState<PadValues>(initial ?? { left: DEFAULT_PAD, top: DEFAULT_PAD, right: DEFAULT_PAD, bottom: DEFAULT_PAD });
  const [feathering, setFeathering] = useState(DEFAULT_FEATHER);
  const [linked, setLinked] = useState(false);
  // Start with size 0 — the canvas stays blank until the container's
  // ResizeObserver reports real dimensions. A non-zero default (was 400×400)
  // caused the first paint to render at the wrong size and only fix itself
  // after the user resized the browser.
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 });
  const [imgLoaded, setImgLoaded] = useState(false);

  const dragging = useRef<{ edge: Edge; startPx: number; startVal: number } | null>(null);

  // Load the image once. Bumps `imgLoaded` so the redraw effect (which has
  // the freshest closure over canvasSize) runs once both pieces are ready —
  // calling `redraw()` directly here would capture a stale canvasSize from
  // the closure created by this effect.
  useEffect(() => {
    const img = new Image();
    img.onload = () => { imgRef.current = img; setImgLoaded(true); };
    img.src = imageSrc;
  }, [imageSrc]);

  // Resize canvas to fill container. Seed with synchronous clientWidth /
  // clientHeight on mount so the very first paint matches the modal's real
  // dimensions, then observe further size changes.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const sync = () => {
      const { clientWidth: w, clientHeight: h } = el;
      if (w > 0 && h > 0) setCanvasSize({ w, h });
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const layout = useCallback(() => {
    const img = imgRef.current;
    if (!img) return null;
    const { w: cw, h: ch } = canvasSize;
    // Responsive scale: the total composition (image + every pad side) must
    // fit inside FIT_FRACTION of the canvas. As pads grow, the image
    // proportionally shrinks so the whole bundle stays visible. When all
    // pads are 0 the image fills the canvas — making the starting state
    // obvious instead of leaving mysterious empty borders.
    const totalNativeW = img.naturalWidth + pad.left + pad.right;
    const totalNativeH = img.naturalHeight + pad.top + pad.bottom;
    const sx = Math.min(
      (cw * FIT_FRACTION) / totalNativeW,
      (ch * FIT_FRACTION) / totalNativeH,
    );
    const imgDisplayW = img.naturalWidth * sx;
    const imgDisplayH = img.naturalHeight * sx;
    const pxLeft = pad.left * sx;
    const pxTop = pad.top * sx;
    const pxRight = pad.right * sx;
    const pxBottom = pad.bottom * sx;
    const totalW = imgDisplayW + pxLeft + pxRight;
    const totalH = imgDisplayH + pxTop + pxBottom;
    const ox = (cw - totalW) / 2;
    const oy = (ch - totalH) / 2;
    return { ox, oy, pxLeft, pxTop, pxRight, pxBottom, imgDisplayW, imgDisplayH, sx };
  }, [canvasSize, pad]);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { w, h } = canvasSize;
    canvas.width = w;
    canvas.height = h;
    ctx.clearRect(0, 0, w, h);

    const l = layout();
    if (!l) return;
    const { ox, oy, pxLeft, pxTop, pxRight, pxBottom, imgDisplayW, imgDisplayH } = l;

    // Draw checkerboard for pad regions.
    const drawChecker = (x: number, y: number, rw: number, rh: number) => {
      if (rw <= 0 || rh <= 0) return;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, rw, rh);
      ctx.clip();
      const cs = CHECKERBOARD_SIZE;
      for (let cy = y - (y % cs); cy < y + rh; cy += cs) {
        for (let cx = x - (x % cs); cx < x + rw; cx += cs) {
          ctx.fillStyle = ((Math.floor(cx / cs) + Math.floor(cy / cs)) % 2 === 0) ? '#ccc' : '#eee';
          ctx.fillRect(cx, cy, cs, cs);
        }
      }
      ctx.restore();
    };

    // Left pad
    drawChecker(ox, oy, pxLeft, pxTop + imgDisplayH + pxBottom);
    // Right pad
    drawChecker(ox + pxLeft + imgDisplayW, oy, pxRight, pxTop + imgDisplayH + pxBottom);
    // Top pad (between left and right strips)
    drawChecker(ox + pxLeft, oy, imgDisplayW, pxTop);
    // Bottom pad
    drawChecker(ox + pxLeft, oy + pxTop + imgDisplayH, imgDisplayW, pxBottom);

    // Image
    ctx.drawImage(img, ox + pxLeft, oy + pxTop, imgDisplayW, imgDisplayH);

    // Border around entire padded area.
    ctx.strokeStyle = 'rgba(99,102,241,0.7)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(ox, oy, pxLeft + imgDisplayW + pxRight, pxTop + imgDisplayH + pxBottom);

    // Per-side labels with directional arrows so it reads as "extend by N
    // pixels outward", not the cryptic L/T/R/B abbreviation. Placed inside
    // the pad zone when there's room; if the zone is too thin, label hangs
    // just outside the image instead so the value stays visible.
    ctx.font = '11px monospace';
    ctx.fillStyle = '#3730a3';
    ctx.textAlign = 'center';
    const labelLeft   = pad.left   > 0 ? `← +${pad.left}` : '';
    const labelRight  = pad.right  > 0 ? `+${pad.right} →` : '';
    const labelTop    = pad.top    > 0 ? `↑ +${pad.top}` : '';
    const labelBottom = pad.bottom > 0 ? `+${pad.bottom} ↓` : '';
    if (labelLeft)   ctx.fillText(labelLeft,   ox + pxLeft / 2, oy + pxTop + imgDisplayH / 2);
    if (labelRight)  ctx.fillText(labelRight,  ox + pxLeft + imgDisplayW + pxRight / 2, oy + pxTop + imgDisplayH / 2);
    if (labelTop)    ctx.fillText(labelTop,    ox + pxLeft + imgDisplayW / 2, oy + pxTop / 2 + 4);
    if (labelBottom) ctx.fillText(labelBottom, ox + pxLeft + imgDisplayW / 2, oy + pxTop + imgDisplayH + pxBottom / 2 + 4);

    // Drag handles on every edge — visible affordance for "grab to extend",
    // including when the pad on that side is 0 (no checkerboard to grab).
    // Each handle is a short thick bar at the midpoint of the outer edge.
    const drawHandle = (x: number, y: number, w: number, h: number) => {
      ctx.fillStyle = 'rgba(99,102,241,0.85)';
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      // Two parallel grip lines inside the handle.
      if (w > h) {
        ctx.fillRect(x + w / 2 - 6, y + 2, 2, h - 4);
        ctx.fillRect(x + w / 2 + 4, y + 2, 2, h - 4);
      } else {
        ctx.fillRect(x + 2, y + h / 2 - 6, w - 4, 2);
        ctx.fillRect(x + 2, y + h / 2 + 4, w - 4, 2);
      }
    };
    const HX = ox + pxLeft + imgDisplayW / 2;
    const HY = oy + pxTop + imgDisplayH / 2;
    drawHandle(ox - 3,                                HY - 16, 6, 32); // left
    drawHandle(ox + pxLeft + imgDisplayW + pxRight - 3, HY - 16, 6, 32); // right
    drawHandle(HX - 16, oy - 3,                                32, 6); // top
    drawHandle(HX - 16, oy + pxTop + imgDisplayH + pxBottom - 3, 32, 6); // bottom
  }, [canvasSize, pad, layout]);

  // Redraw whenever the layout inputs change OR the image first loads.
  // Including `imgLoaded` in the deps closes the mount-race: when the image
  // resolves AFTER the container has reported its real size, we still get a
  // paint at the correct dimensions.
  useEffect(() => { redraw(); }, [redraw, imgLoaded]);

  const hitEdge = (x: number, y: number): Edge | null => {
    const l = layout();
    if (!l) return null;
    const { ox, oy, pxLeft, pxTop, pxRight, pxBottom, imgDisplayW, imgDisplayH } = l;
    const leftEdge = ox + pxLeft;
    const topEdge = oy + pxTop;
    const rightEdge = ox + pxLeft + imgDisplayW + pxRight;
    const bottomEdge = oy + pxTop + imgDisplayH + pxBottom;
    const midY = oy + (pxTop + imgDisplayH) / 2 + pxTop / 2;
    const midX = ox + (pxLeft + imgDisplayW) / 2 + pxLeft / 2;
    void midY; void midX;
    if (Math.abs(x - ox) < HANDLE_HIT) return 'left';
    if (Math.abs(x - rightEdge) < HANDLE_HIT) return 'right';
    if (Math.abs(y - oy) < HANDLE_HIT) return 'top';
    if (Math.abs(y - bottomEdge) < HANDLE_HIT) return 'bottom';
    return null;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const edge = hitEdge(x, y);
    if (!edge) return;
    const current = pad[edge];
    const axis = edge === 'left' || edge === 'right' ? x : y;
    dragging.current = { edge, startPx: axis, startVal: current };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragging.current) return;
    const l = layout();
    if (!l) return;
    const { edge, startPx, startVal } = dragging.current;
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const axis = edge === 'left' || edge === 'right' ? x : y;
    // sign: dragging left edge leftward increases pad.left, etc.
    const sign = (edge === 'right' || edge === 'bottom') ? 1 : -1;
    const delta = (axis - startPx) * sign / l.sx;
    const newVal = Math.max(0, Math.round(startVal + delta));
    setPad(prev => {
      if (linked) return { left: newVal, top: newVal, right: newVal, bottom: newVal };
      return { ...prev, [edge]: newVal };
    });
  };

  const onPointerUp = () => { dragging.current = null; };

  const handleSave = () => onSave({ ...pad, feathering });

  return (
    <div className="flex flex-col gap-3 h-full">
      {/* Hint */}
      <p className="text-[11px] text-muted-foreground">
        Drag any edge outward to extend the canvas on that side. The model will
        fill the new (checkerboard) area; your original image stays untouched.
      </p>

      {/* Canvas */}
      <div ref={containerRef} className="flex-1 min-h-0 rounded-lg overflow-hidden bg-muted/50">
        <canvas
          ref={canvasRef}
          style={{ width: canvasSize.w, height: canvasSize.h, cursor: 'grab' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <Switch size="sm" checked={linked} onCheckedChange={setLinked} />
          Extend the same amount on all sides
        </label>
        <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
          Feathering
          <input
            type="number"
            value={feathering}
            min={0}
            max={512}
            onChange={e => setFeathering(Math.max(0, Number(e.target.value) || 0))}
            className="field-input w-16 tabular-nums text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          />
          px
        </label>
        <span className="text-[11px] text-muted-foreground ml-auto tabular-nums">
          Final canvas: {(imgRef.current?.naturalWidth ?? 0) + pad.left + pad.right}
          {' × '}
          {(imgRef.current?.naturalHeight ?? 0) + pad.top + pad.bottom} px
        </span>
      </div>

      {/* Footer */}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
        <Button type="button" onClick={handleSave}>Apply outpaint area</Button>
      </div>
    </div>
  );
}
