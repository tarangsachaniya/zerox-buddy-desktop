import { PDFDocument, rgb } from "pdf-lib";
import type { PDFPage } from "pdf-lib";

import type { Margins, SheetLayout } from "../../shared/passport/layout";
import { mmToPt } from "../../shared/passport/units";
import { drawRotated } from "../scanning/compose";

/**
 * A passport sheet layout → a PDF at exact physical size. The approved photo
 * is one JPEG already cropped to the photo's aspect ratio, embedded once and
 * drawn into every cell at the cell's size in points, so nothing is stretched
 * and the pixel count (DPI) never changes the printed size.
 *
 *   export   pages in the sheet's own orientation, for saving
 *   print    portrait pages for SumatraPDF's `noscale`: a landscape sheet is
 *            turned a quarter-turn clockwise inside the page (as layout.ts
 *            does for other prints), and everything is shifted back by the
 *            printer's hard margins, because `noscale` puts the page's corner
 *            at the printable area's corner, not the paper's
 */

export type PassportPdfOptions = {
  forPrint: boolean;
  /** Portrait-page hard margins, print only. */
  hardMargins?: Margins | null;
  border: { enabled: boolean; thicknessMm: number };
  title?: string;
};

type Box = { x: number; y: number; w: number; h: number };

function drawBorder(page: PDFPage, box: Box, thicknessMm: number): void {
  const t = mmToPt(thicknessMm);
  // Inside the photo's edge, so the outside of the line is the photo's exact size to cut along.
  page.drawRectangle({ x: box.x + t / 2, y: box.y + t / 2, width: box.w - t, height: box.h - t, borderWidth: t, borderColor: rgb(0, 0, 0) });
}

export async function buildPassportPdf(photoJpeg: Uint8Array, layout: SheetLayout, opts: PassportPdfOptions): Promise<{ bytes: Uint8Array; sheets: number }> {
  if (layout.errors.length) throw new Error(layout.errors[0]);
  if (layout.pages.length === 0) throw new Error("Nothing to put on the sheet");
  const doc = await PDFDocument.create();
  doc.setTitle(opts.title ?? "Passport photos");
  doc.setProducer("Zerox Buddy");
  let image;
  try {
    image = await doc.embedJpg(photoJpeg);
  } catch {
    throw new Error("The photo couldn't be added to the PDF. Crop it again and retry");
  }

  const landscape = layout.paper.widthMm > layout.paper.heightMm;
  const turn = opts.forPrint && landscape;
  const pageMm = turn ? { w: layout.paper.heightMm, h: layout.paper.widthMm } : { w: layout.paper.widthMm, h: layout.paper.heightMm };
  const shift = opts.forPrint && opts.hardMargins ? { x: opts.hardMargins.left, y: opts.hardMargins.top } : { x: 0, y: 0 };
  const pageW = mmToPt(pageMm.w);
  const pageH = mmToPt(pageMm.h);

  for (const cells of layout.pages) {
    const page = doc.addPage([pageW, pageH]);
    for (const c of cells) {
      // In the page's own frame, millimetres, y down.
      const r = turn ? { x: layout.paper.heightMm - c.y - c.h, y: c.x, w: c.h, h: c.w } : c;
      const box: Box = {
        x: mmToPt(r.x - shift.x),
        y: pageH - mmToPt(r.y - shift.y + r.h),
        w: mmToPt(r.w),
        h: mmToPt(r.h),
      };
      drawRotated(page, image, turn ? 90 : 0, box);
      if (opts.border.enabled) drawBorder(page, box, opts.border.thicknessMm);
    }
  }
  return { bytes: await doc.save(), sheets: doc.getPageCount() };
}
