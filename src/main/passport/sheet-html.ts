import type { SheetLayout } from "../../shared/passport/layout";
import { printBoxes, printPage } from "../../shared/passport/print-boxes";

/**
 * A passport sheet as an HTML page for Chromium's print engine (the one
 * Ctrl+P uses): @page at the exact paper size with no margins, every photo
 * an <img> placed in millimetres. Chromium sends the photo to the printer as
 * a compressed image and lets the driver render it at its own resolution, so
 * a 1200 dpi job stays a few MB (SumatraPDF sent a 16 MB bitmap that made an
 * HP Ink Tank stall and smear the end of the sheet). Pure.
 *
 * `photoSrc` is a URL relative to the HTML file (the JPEG is written next to
 * it), so the photo is in the document once however many copies are on it.
 */

const mm = (n: number) => `${Number(n.toFixed(4))}mm`;

export function buildSheetHtml(layout: SheetLayout, photoSrc: string, border: { enabled: boolean; thicknessMm: number }): string {
  if (layout.errors.length) throw new Error(layout.errors[0]);
  if (layout.pages.length === 0) throw new Error("Nothing to put on the sheet");
  const page = printPage(layout);
  const src = photoSrc.replace(/"/g, "%22");
  const pages = layout.pages.map((_, i) => {
    const p = layout.insetMm;
    const cells = printBoxes(layout, i).map((b) => {
      // The box is the frame; the photo is the frame less the border's white gap on each side.
      const img =
        b.rotation === 90
          ? // The photo keeps its own shape (box sides swapped back) and is turned about the box centre.
            `<img src="${src}" alt="" style="left:50%;top:50%;width:${mm(b.h - 2 * p)};height:${mm(b.w - 2 * p)};transform:translate(-50%,-50%) rotate(90deg)">`
          : `<img src="${src}" alt="" style="left:${mm(p)};top:${mm(p)};width:${mm(b.w - 2 * p)};height:${mm(b.h - 2 * p)}">`;
      const edge = border.enabled ? `<div class="edge" style="border-width:${mm(border.thicknessMm)}"></div>` : "";
      return `<div class="cell" style="left:${mm(b.x)};top:${mm(b.y)};width:${mm(b.w)};height:${mm(b.h)}">${img}${edge}</div>`;
    });
    return `<div class="page">${cells.join("")}</div>`;
  });
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Passport photos</title>
<style>
@page { size: ${mm(page.widthMm)} ${mm(page.heightMm)}; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; }
.page { position: relative; width: ${mm(page.widthMm)}; height: ${mm(page.heightMm)}; overflow: hidden; break-after: page; }
.page:last-child { break-after: auto; }
.cell { position: absolute; overflow: hidden; }
.cell img { position: absolute; display: block; }
.edge { position: absolute; inset: 0; box-sizing: border-box; border-style: solid; border-color: #000; }
</style></head>
<body>${pages.join("")}</body></html>
`;
}
