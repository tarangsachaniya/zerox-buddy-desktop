import { mmToPx } from "./units";

/**
 * Crop geometry for the passport photo editor. Pure.
 *
 * The photo is turned about its centre by `rotation90 + fineDeg` (clockwise,
 * y down) to give the "view"; the crop window is an axis-aligned rectangle in
 * that view, centred at (cx, cy) relative to the view's centre, `w` source
 * pixels wide and always `w / aspect` tall. The original image is never
 * changed: the crop is just these numbers until the operator approves it, and
 * the approved photo is rendered from them at the print DPI.
 *
 * Every corner of the window must lie on the photo, so a fine rotation never
 * shows blank corners and nothing is stretched.
 */

export type Rotation90 = 0 | 90 | 180 | 270;

export type PhotoCrop = {
  cx: number;
  cy: number;
  w: number;
  rotation90: Rotation90;
  fineDeg: number;
};

export const MAX_FINE_DEG = 15;
export const MAX_ZOOM = 8;
const EPS = 1e-6;

export type Size = { width: number; height: number };

export function angleRad(crop: Pick<PhotoCrop, "rotation90" | "fineDeg">): number {
  return ((crop.rotation90 + crop.fineDeg) * Math.PI) / 180;
}

/** The turned photo's bounding box (what the editor shows). */
export function viewSize(src: Size, rotation90: Rotation90, fineDeg = 0): Size {
  const a = angleRad({ rotation90, fineDeg });
  const c = Math.abs(Math.cos(a));
  const s = Math.abs(Math.sin(a));
  return { width: src.width * c + src.height * s, height: src.width * s + src.height * c };
}

/** The crop window's corners in view coordinates (relative to the view centre). */
export function cropCorners(crop: PhotoCrop, aspect: number): Array<[number, number]> {
  const hw = crop.w / 2;
  const hh = crop.w / aspect / 2;
  return [
    [crop.cx - hw, crop.cy - hh],
    [crop.cx + hw, crop.cy - hh],
    [crop.cx + hw, crop.cy + hh],
    [crop.cx - hw, crop.cy + hh],
  ];
}

/** A view point back on the unturned photo (relative to the photo's centre). */
export function viewToSource(x: number, y: number, a: number): [number, number] {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [x * c + y * s, -x * s + y * c];
}

/** Whether every corner of the window lies on the photo. */
export function cropFits(crop: PhotoCrop, src: Size, aspect: number): boolean {
  const a = angleRad(crop);
  const hw = src.width / 2 + EPS;
  const hh = src.height / 2 + EPS;
  return cropCorners(crop, aspect).every(([x, y]) => {
    const [sx, sy] = viewToSource(x, y, a);
    return Math.abs(sx) <= hw && Math.abs(sy) <= hh;
  });
}

/** The widest window at this aspect that fits when centred. */
export function maxCropWidth(src: Size, aspect: number, rotation90: Rotation90, fineDeg: number): number {
  let lo = 0;
  let hi = Math.max(src.width, src.height) * 2;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (cropFits({ cx: 0, cy: 0, w: mid, rotation90, fineDeg }, src, aspect)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** The largest centred window at this aspect — the starting crop. */
export function initialCrop(src: Size, aspect: number, rotation90: Rotation90 = 0, fineDeg = 0): PhotoCrop {
  assertAspect(aspect);
  return { cx: 0, cy: 0, w: maxCropWidth(src, aspect, rotation90, fineDeg), rotation90, fineDeg };
}

/**
 * Kept on the photo: the width is capped at what fits centred, then the
 * window is pulled towards the centre just far enough for every corner to lie
 * on the photo.
 */
export function clampCrop(crop: PhotoCrop, src: Size, aspect: number): PhotoCrop {
  assertAspect(aspect);
  const fineDeg = Math.max(-MAX_FINE_DEG, Math.min(MAX_FINE_DEG, Number.isFinite(crop.fineDeg) ? crop.fineDeg : 0));
  const maxW = maxCropWidth(src, aspect, crop.rotation90, fineDeg);
  const minW = Math.min(maxW, maxW / MAX_ZOOM);
  const w = Math.max(minW, Math.min(maxW, Number.isFinite(crop.w) ? crop.w : maxW));
  const next: PhotoCrop = { ...crop, fineDeg, w, cx: Number.isFinite(crop.cx) ? crop.cx : 0, cy: Number.isFinite(crop.cy) ? crop.cy : 0 };
  if (cropFits(next, src, aspect)) return next;
  // The centres that fit form a convex region containing (0, 0), so the
  // furthest fitting point on the line back to the centre is found by halving.
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (cropFits({ ...next, cx: next.cx * mid, cy: next.cy * mid }, src, aspect)) lo = mid;
    else hi = mid;
  }
  return { ...next, cx: next.cx * lo, cy: next.cy * lo };
}

/** 1 = the widest window; larger zooms in. */
export function cropZoom(crop: PhotoCrop, src: Size, aspect: number): number {
  const maxW = maxCropWidth(src, aspect, crop.rotation90, crop.fineDeg);
  return crop.w > 0 ? maxW / crop.w : 1;
}

export function zoomCrop(crop: PhotoCrop, zoom: number, src: Size, aspect: number): PhotoCrop {
  const z = Math.max(1, Math.min(MAX_ZOOM, zoom));
  const maxW = maxCropWidth(src, aspect, crop.rotation90, crop.fineDeg);
  return clampCrop({ ...crop, w: maxW / z }, src, aspect);
}

/**
 * The photo's size changed (e.g. 35×45 → 40×50): the same part of the photo
 * stays selected — same centre, same zoom — and only the window's shape
 * follows the new ratio.
 */
export function reshapeCrop(crop: PhotoCrop, src: Size, fromAspect: number, toAspect: number): PhotoCrop {
  const zoom = cropZoom(crop, src, fromAspect);
  return zoomCrop({ ...crop }, zoom, src, toAspect);
}

export function moveCrop(crop: PhotoCrop, dx: number, dy: number, src: Size, aspect: number): PhotoCrop {
  return clampCrop({ ...crop, cx: crop.cx + dx, cy: crop.cy + dy }, src, aspect);
}

/** Resized about its centre, the aspect ratio kept. */
export function resizeCrop(crop: PhotoCrop, w: number, src: Size, aspect: number): PhotoCrop {
  return clampCrop({ ...crop, w }, src, aspect);
}

/** A quarter turn; the window keeps its zoom and goes back to the centre. */
export function rotateCrop90(crop: PhotoCrop, dir: "cw" | "ccw", src: Size, aspect: number): PhotoCrop {
  const zoom = cropZoom(crop, src, aspect);
  const rotation90 = (((crop.rotation90 + (dir === "cw" ? 90 : 270)) % 360) as Rotation90);
  return zoomCrop({ ...crop, rotation90, cx: 0, cy: 0 }, zoom, src, aspect);
}

export function setFineRotation(crop: PhotoCrop, fineDeg: number, src: Size, aspect: number): PhotoCrop {
  return clampCrop({ ...crop, fineDeg }, src, aspect);
}

/** The approved photo's bitmap size: the physical size at the print DPI. */
export function outputPixelSize(widthMm: number, heightMm: number, dpi: number): Size {
  if (!(widthMm > 0) || !(heightMm > 0)) throw new Error("Photo width and height must be more than 0 mm");
  if (!(dpi >= 72 && dpi <= 1200)) throw new Error("Resolution must be between 72 and 1200 DPI");
  return { width: Math.max(1, mmToPx(widthMm, dpi)), height: Math.max(1, mmToPx(heightMm, dpi)) };
}

/**
 * The 2D transform (canvas setTransform order a,b,c,d,e,f) that draws the
 * unturned photo, centred at the origin, into an output bitmap of `out` so the
 * crop window fills it exactly. Used by the renderer; kept here so it's tested.
 */
export function renderTransform(crop: PhotoCrop, out: Size): [number, number, number, number, number, number] {
  const k = out.width / crop.w;
  const a = angleRad(crop);
  const c = Math.cos(a) * k;
  const s = Math.sin(a) * k;
  // out = k * (R(a) * p - centre) + out/2
  return [c, s, -s, c, out.width / 2 - k * crop.cx, out.height / 2 - k * crop.cy];
}

function assertAspect(aspect: number): void {
  if (!(aspect > 0) || !Number.isFinite(aspect)) throw new Error("Photo width and height must be more than 0 mm");
}
