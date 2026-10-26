import type { CropRect, ScanRotation } from "./types";

/**
 * A crop is stored on the scan as the scanner wrote it (before rotation);
 * the crop editor works on the page as it's shown (after the operator's
 * clockwise rotation). These convert between the two.
 */

export const FULL: CropRect = { x: 0, y: 0, w: 1, h: 1 };

/** Unrotated → as shown, after turning `rotation` degrees clockwise. */
export function toRotated(r: CropRect, rotation: ScanRotation): CropRect {
  switch (rotation) {
    case 90:
      return { x: 1 - r.y - r.h, y: r.x, w: r.h, h: r.w };
    case 180:
      return { x: 1 - r.x - r.w, y: 1 - r.y - r.h, w: r.w, h: r.h };
    case 270:
      return { x: r.y, y: 1 - r.x - r.w, w: r.h, h: r.w };
    default:
      return { ...r };
  }
}

/** As shown → unrotated; the inverse of toRotated. */
export function toUnrotated(r: CropRect, rotation: ScanRotation): CropRect {
  const back = ((360 - rotation) % 360) as ScanRotation;
  return toRotated(r, back);
}

/** Kept inside the image, at least `min` on each side. */
export function clampCrop(r: CropRect, min = 0.05): CropRect {
  const w = Math.min(1, Math.max(min, r.w));
  const h = Math.min(1, Math.max(min, r.h));
  return { x: Math.min(1 - w, Math.max(0, r.x)), y: Math.min(1 - h, Math.max(0, r.y)), w, h };
}

export function isFull(r: CropRect | null): boolean {
  return !r || (r.x <= 0.001 && r.y <= 0.001 && r.w >= 0.999 && r.h >= 0.999);
}
