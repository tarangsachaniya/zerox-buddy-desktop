import { PDFDocument, degrees } from "pdf-lib";
import type { PDFImage, PDFPage } from "pdf-lib";

import type { PaperSize } from "../../shared/types";
import { paperMm } from "../printing/layout";

/**
 * Scanned pages → one PDF, for Save as PDF and for photocopies.
 *
 *   normal   one page per scan on the chosen paper, fitted and centered;
 *            a page turned sideways gets a landscape sheet
 *   idCard   front and back of a card on one sheet, top and bottom half, at
 *            their real size (from the scan's dpi), so the copy measures
 *            like the card
 *
 * Rotation is the operator's, clockwise, in quarter turns.
 */

export type Rotation = 0 | 90 | 180 | 270;

export type ComposePage = {
  /** JPEG bytes as the scanner wrote them. */
  jpeg: Uint8Array;
  rotation: Rotation;
  dpi: number;
};

const PT_PER_MM = 72 / 25.4;

/** Draws `image` rotated clockwise so its rotated bounding box starts at (x, y) with size w × h. */
function drawRotated(page: PDFPage, image: PDFImage, rotation: Rotation, box: { x: number; y: number; w: number; h: number }): void {
  // Unrotated draw size: a quarter turn swaps the box's sides.
  const quarter = rotation === 90 || rotation === 270;
  const width = quarter ? box.h : box.w;
  const height = quarter ? box.w : box.h;
  // pdf-lib turns counter-clockwise around the image's lower-left corner;
  // move that corner so the turned image lands exactly on the box.
  const at = {
    0: { x: box.x, y: box.y },
    90: { x: box.x, y: box.y + box.h },
    180: { x: box.x + box.w, y: box.y + box.h },
    270: { x: box.x + box.w, y: box.y },
  }[rotation];
  page.drawImage(image, { x: at.x, y: at.y, width, height, rotate: degrees(-rotation) });
}

/** The image's size in points once rotated, at its real scanned size. */
function realSize(image: PDFImage, p: ComposePage): { w: number; h: number } {
  const w = (image.width / p.dpi) * 72;
  const h = (image.height / p.dpi) * 72;
  return p.rotation === 90 || p.rotation === 270 ? { w: h, h: w } : { w, h };
}

export async function composePdf(pages: ComposePage[], opts: { paperSize: PaperSize; idCard: boolean }): Promise<{ bytes: Uint8Array; sheets: number }> {
  if (pages.length === 0) throw new Error("Scan at least one page first");
  const doc = await PDFDocument.create();
  const [mmW, mmH] = paperMm(opts.paperSize);
  const portrait = { w: Math.min(mmW, mmH) * PT_PER_MM, h: Math.max(mmW, mmH) * PT_PER_MM };

  if (opts.idCard) {
    for (let i = 0; i < pages.length; i += 2) {
      const sheet = doc.addPage([portrait.w, portrait.h]);
      const pair = pages.slice(i, i + 2);
      for (const [slot, p] of pair.entries()) {
        const image = await doc.embedJpg(p.jpeg);
        const size = realSize(image, p);
        // Each card centered in its half; shrunk only if it wouldn't fit.
        const half = { w: portrait.w, h: portrait.h / 2 };
        const scale = Math.min(1, (half.w * 0.9) / size.w, (half.h * 0.9) / size.h);
        const w = size.w * scale;
        const h = size.h * scale;
        const top = slot === 0;
        const y = (top ? half.h : 0) + (half.h - h) / 2;
        drawRotated(sheet, image, p.rotation, { x: (portrait.w - w) / 2, y, w, h });
      }
    }
    return { bytes: await doc.save(), sheets: doc.getPageCount() };
  }

  for (const p of pages) {
    const image = await doc.embedJpg(p.jpeg);
    const size = realSize(image, p);
    const landscape = size.w > size.h;
    const sheetW = landscape ? portrait.h : portrait.w;
    const sheetH = landscape ? portrait.w : portrait.h;
    const sheet = doc.addPage([sheetW, sheetH]);
    const scale = Math.min(sheetW / size.w, sheetH / size.h);
    const w = size.w * scale;
    const h = size.h * scale;
    drawRotated(sheet, image, p.rotation, { x: (sheetW - w) / 2, y: (sheetH - h) / 2, w, h });
  }
  return { bytes: await doc.save(), sheets: doc.getPageCount() };
}
