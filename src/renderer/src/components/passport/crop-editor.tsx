import { RotateCcw, RotateCw, Undo2, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  MAX_FINE_DEG,
  MAX_ZOOM,
  angleRad,
  cropZoom,
  initialCrop,
  moveCrop,
  resizeCrop,
  rotateCrop90,
  setFineRotation,
  viewSize,
  zoomCrop,
  type PhotoCrop,
} from "../../../../shared/passport/crop";
import { Button } from "@/components/ui/button";
import { drawCrop, type EditablePhoto } from "@/lib/passport-render";

/**
 * The passport crop editor: the photo turned as the operator wants, a crop
 * window locked to the photo's aspect ratio, drag to move, drag a corner to
 * resize, wheel or slider to zoom, quarter turns and a fine straighten. Only
 * numbers change (PhotoCrop); the original photo is untouched until the
 * operator approves.
 */

const HANDLE = 14;

type Drag = { kind: "move"; x: number; y: number; start: PhotoCrop } | { kind: "resize"; start: PhotoCrop };

export function CropEditor({
  photo,
  aspect,
  crop,
  onChange,
}: {
  photo: EditablePhoto;
  /** Photo width ÷ height. */
  aspect: number;
  crop: PhotoCrop;
  onChange: (crop: PhotoCrop) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState({ width: 560, height: 420 });
  const drag = useRef<Drag | null>(null);
  const src = photo.size;

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setBox({ width: Math.max(200, width), height: Math.max(200, height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const view = viewSize(src, crop.rotation90, crop.fineDeg);
  const f = Math.min(box.width / view.width, box.height / view.height) * 0.94;
  const cropH = crop.w / aspect;
  const rect = {
    x: box.width / 2 + (crop.cx - crop.w / 2) * f,
    y: box.height / 2 + (crop.cy - cropH / 2) * f,
    w: crop.w * f,
    h: cropH * f,
  };

  // The turned photo, dimmed outside the window.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(box.width * dpr);
    canvas.height = Math.round(box.height * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, box.width, box.height);
    ctx.save();
    ctx.translate(box.width / 2, box.height / 2);
    ctx.scale(f, f);
    ctx.rotate(angleRad(crop));
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(photo.bitmap, -src.width / 2, -src.height / 2, src.width, src.height);
    ctx.restore();
    ctx.fillStyle = "rgba(15, 23, 20, 0.55)";
    ctx.beginPath();
    ctx.rect(0, 0, box.width, box.height);
    ctx.rect(rect.x, rect.y, rect.w, rect.h);
    ctx.fill("evenodd");
    // Thirds, to line up eyes and chin.
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const t of [1 / 3, 2 / 3]) {
      ctx.moveTo(rect.x + rect.w * t, rect.y);
      ctx.lineTo(rect.x + rect.w * t, rect.y + rect.h);
      ctx.moveTo(rect.x, rect.y + rect.h * t);
      ctx.lineTo(rect.x + rect.w, rect.y + rect.h * t);
    }
    ctx.stroke();
  }, [box, crop, f, photo, rect.h, rect.w, rect.x, rect.y, src.height, src.width]);

  // The cropped result, small.
  useEffect(() => {
    const canvas = previewRef.current;
    if (!canvas) return;
    const w = 132;
    void drawCrop(canvas, photo, crop, { width: w, height: Math.max(1, Math.round(w / aspect)) }).catch(() => {});
  }, [photo, crop, aspect]);

  function local(e: React.PointerEvent): { x: number; y: number } {
    const r = boxRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function onPointerDown(e: React.PointerEvent) {
    const p = local(e);
    const corners = [
      [rect.x, rect.y],
      [rect.x + rect.w, rect.y],
      [rect.x, rect.y + rect.h],
      [rect.x + rect.w, rect.y + rect.h],
    ];
    const onCorner = corners.some(([cx, cy]) => Math.abs(p.x - cx) <= HANDLE && Math.abs(p.y - cy) <= HANDLE);
    const inside = p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h;
    if (!onCorner && !inside) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = onCorner ? { kind: "resize", start: crop } : { kind: "move", x: p.x, y: p.y, start: crop };
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const p = local(e);
    if (d.kind === "move") {
      onChange(moveCrop(d.start, (p.x - d.x) / f, (p.y - d.y) / f, src, aspect));
    } else {
      // About the centre: the corner follows the pointer, the ratio stays.
      const vx = (p.x - box.width / 2) / f - d.start.cx;
      const vy = (p.y - box.height / 2) / f - d.start.cy;
      onChange(resizeCrop(d.start, Math.max(Math.abs(vx) * 2, Math.abs(vy) * 2 * aspect), src, aspect));
    }
  }

  function onPointerUp() {
    drag.current = null;
  }

  const zoom = cropZoom(crop, src, aspect);

  return (
    <div className="grid gap-3">
      <div
        ref={boxRef}
        className="relative h-[min(52dvh,460px)] touch-none select-none overflow-hidden rounded-2xl bg-deep/90"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={(e) => onChange(zoomCrop(crop, zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08), src, aspect))}
        role="application"
        aria-label="Crop the photo: drag to move, drag a corner to resize, scroll to zoom"
      >
        <canvas ref={canvasRef} className="absolute inset-0 size-full" />
        <div
          aria-hidden
          className="pointer-events-none absolute border-2 border-lime"
          style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
        >
          {["-left-1.5 -top-1.5", "-right-1.5 -top-1.5", "-bottom-1.5 -left-1.5", "-bottom-1.5 -right-1.5"].map((pos) => (
            <span key={pos} className={`absolute size-3 rounded-sm bg-lime ${pos}`} />
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1">
          <Button size="icon-sm" variant="secondary" aria-label="Turn left" onClick={() => onChange(rotateCrop90(crop, "ccw", src, aspect))}>
            <RotateCcw aria-hidden />
          </Button>
          <Button size="icon-sm" variant="secondary" aria-label="Turn right" onClick={() => onChange(rotateCrop90(crop, "cw", src, aspect))}>
            <RotateCw aria-hidden />
          </Button>
        </div>
        <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <ZoomOut className="size-4" aria-hidden />
          <input
            type="range"
            min={1}
            max={MAX_ZOOM}
            step={0.01}
            value={zoom}
            onChange={(e) => onChange(zoomCrop(crop, Number(e.target.value), src, aspect))}
            aria-label="Zoom"
            className="w-28 accent-[hsl(var(--primary))]"
          />
          <ZoomIn className="size-4" aria-hidden />
        </label>
        <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
          Straighten
          <input
            type="range"
            min={-MAX_FINE_DEG}
            max={MAX_FINE_DEG}
            step={0.1}
            value={crop.fineDeg}
            onChange={(e) => onChange(setFineRotation(crop, Number(e.target.value), src, aspect))}
            aria-label="Straighten"
            className="w-28 accent-[hsl(var(--primary))]"
          />
          <span className="w-10 font-mono tabular-nums">{crop.fineDeg.toFixed(1)}°</span>
        </label>
        <Button size="sm" variant="ghost" onClick={() => onChange(initialCrop(src, aspect))}>
          <Undo2 aria-hidden /> Reset
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-caption text-muted-foreground">Result</span>
          <canvas ref={previewRef} className="h-auto w-[66px] rounded border border-border-strong/60 bg-white" />
        </div>
      </div>
    </div>
  );
}
