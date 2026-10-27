import { PDFDocument, rgb } from "pdf-lib";
import type { PDFPage } from "pdf-lib";

import type { SheetLayout } from "../../shared/passport/layout";
import { mmToPt } from "../../shared/passport/units";

/**
 * A passport sheet layout → a PDF at exact physical size. The approved photo
 * is one JPEG already cropped to the photo's aspect ratio, embedded once and
 * drawn into every cell at the cell's size in points, so nothing is stretched
 * and the pixel count (DPI) never changes the printed size.
 *
 * Pages keep the sheet's own orientation; this is the "Save PDF" file. The
 * printed page is HTML (sheet-html.ts), placed by the same layout.
 */

export type PassportPdfOptions = {
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

  const pageW = mmToPt(layout.paper.widthMm);
  const pageH = mmToPt(layout.paper.heightMm);

  for (const cells of layout.pages) {
    const page = doc.addPage([pageW, pageH]);
    for (const c of cells) {
      // The cell is the frame; the photo sits inside it by the border's white gap.
      const box: Box = { x: mmToPt(c.x), y: pageH - mmToPt(c.y + c.h), w: mmToPt(c.w), h: mmToPt(c.h) };
      const inset = mmToPt(layout.insetMm);
      page.drawImage(image, { x: box.x + inset, y: box.y + inset, width: box.w - 2 * inset, height: box.h - 2 * inset });
      if (opts.border.enabled) drawBorder(page, box, opts.border.thicknessMm);
    }
  }
  return { bytes: await doc.save(), sheets: doc.getPageCount() };
}
