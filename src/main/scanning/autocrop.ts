import type { CropRect } from "../../shared/types";

/**
 * Finds an ID card in a scan of the card-sized corner of the glass, so only
 * the card is printed (not the dark lid or glass around it).
 *
 *   background  the median colour of the scan's 2 px border
 *   card        rows and columns where enough pixels differ from it
 *   sanity      the box must look like a card (area and shape); otherwise
 *               null, and the whole scan is kept (a white lid, a blank scan)
 *
 * Pure: takes a BGRA bitmap (nativeImage.toBitmap()), usually a small copy.
 */

const DIFF = 60;
const LINE_SHARE = 0.15;
const INSET = 0.004;
const MIN_AREA = 0.25;
const MAX_AREA = 0.95;
/** A card is 85.6 × 54 mm, 1.586:1; allow for a slightly skewed scan. */
const MIN_RATIO = 1.35;
const MAX_RATIO = 1.85;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

export function findCardBox(bgra: Uint8Array, width: number, height: number): CropRect | null {
  if (width < 20 || height < 20 || bgra.length < width * height * 4) return null;
  const at = (x: number, y: number) => (y * width + x) * 4;

  const border: [number[], number[], number[]] = [[], [], []];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x > 1 && x < width - 2 && y > 1 && y < height - 2) continue;
      const i = at(x, y);
      border[0].push(bgra[i]!);
      border[1].push(bgra[i + 1]!);
      border[2].push(bgra[i + 2]!);
    }
  }
  const bg = border.map(median);

  const rowHits = new Array<number>(height).fill(0);
  const colHits = new Array<number>(width).fill(0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = at(x, y);
      const d = Math.abs(bgra[i]! - bg[0]!) + Math.abs(bgra[i + 1]! - bg[1]!) + Math.abs(bgra[i + 2]! - bg[2]!);
      if (d > DIFF) {
        rowHits[y]! += 1;
        colHits[x]! += 1;
      }
    }
  }

  const rows = rowHits.map((n) => n / width > LINE_SHARE);
  const cols = colHits.map((n) => n / height > LINE_SHARE);
  const top = rows.indexOf(true);
  const bottom = rows.lastIndexOf(true);
  const left = cols.indexOf(true);
  const right = cols.lastIndexOf(true);
  if (top === -1 || left === -1) return null;

  const box = {
    x: left / width + INSET,
    y: top / height + INSET,
    w: (right + 1 - left) / width - 2 * INSET,
    h: (bottom + 1 - top) / height - 2 * INSET,
  };
  const area = box.w * box.h;
  const pxW = box.w * width;
  const pxH = box.h * height;
  const ratio = Math.max(pxW, pxH) / Math.min(pxW, pxH);
  if (area < MIN_AREA || area > MAX_AREA || ratio < MIN_RATIO || ratio > MAX_RATIO) return null;
  return box;
}
