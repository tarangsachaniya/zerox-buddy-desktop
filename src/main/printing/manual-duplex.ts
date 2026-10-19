import { PDFDocument, degrees } from "pdf-lib";

import type { DuplexFlip } from "../../shared/types";

/**
 * Manual double-sided printing for a printer with no duplex unit. Pure.
 *
 * Takes the print-ready sheets from layout.ts (page ranges, scaling and
 * pages-per-sheet are already applied, so order and content are untouched) and
 * splits them into two simplex passes, odd sheets (1, 3, 5 …) and even
 * sheets (2, 4, 6 …). The owner picks which set prints first; the other set
 * prints after the operator flips the stack. `front` / `back` below are the
 * first and second pass.
 *
 * Every copy is padded to an even number of sheets with a blank, so an odd
 * page count leaves the last back side blank rather than shifting pages, and
 * several copies never share a sheet. `REVERSE` prints the second pass last
 * to first — what a printer that stacks its output face-down needs once the stack
 * is turned over and put back. Which one a printer needs depends on its tray,
 * so the owner chooses.
 *
 * When the operator turns the paper over about the edge the document isn't
 * bound on, the even side lands upside-down; those sheets are rotated 180°.
 */

export type EvenOrder = "REVERSE" | "FORWARD";
export type FirstSet = "ODD" | "EVEN";

export type ManualDuplexSplit = {
  front: Uint8Array;
  back: Uint8Array;
  frontSheets: number;
  backSheets: number;
  /** Each copy has an odd number of sheets, so its last back side is a blank pad. */
  padded: boolean;
};

export async function splitManualDuplex(
  sheets: Uint8Array,
  copies: number,
  evenOrder: EvenOrder,
  flip: DuplexFlip,
  first: FirstSet = "ODD",
): Promise<ManualDuplexSplit> {
  const src = await PDFDocument.load(sheets);
  const count = src.getPageCount();
  if (count === 0) throw new Error("Nothing to print");

  // One entry per physical sheet side across all copies; null is a blank pad.
  const sides: (number | null)[] = [];
  for (let c = 0; c < Math.max(1, copies); c++) {
    for (let i = 0; i < count; i++) sides.push(i);
    if (count % 2 === 1) sides.push(null);
  }

  const odds = sides.filter((_, i) => i % 2 === 0);
  const evens = sides.filter((_, i) => i % 2 === 1);
  const fronts = first === "ODD" ? odds : evens;
  let backs = first === "ODD" ? evens : odds;
  if (evenOrder === "REVERSE") backs = [...backs].reverse();

  const build = async (list: (number | null)[], isEven: boolean): Promise<Uint8Array> => {
    const out = await PDFDocument.create();
    // A blank copies the size of the sheet it backs (the last real sheet).
    const lastSize = src.getPage(count - 1).getSize();
    for (const idx of list) {
      if (idx === null) {
        out.addPage([lastSize.width, lastSize.height]);
        continue;
      }
      const [page] = await out.copyPages(src, [idx]);
      const { width, height } = page!.getSize();
      if (isEven && (flip === "SHORT") !== width > height) {
        page!.setRotation(degrees((page!.getRotation().angle + 180) % 360));
      }
      out.addPage(page!);
    }
    return out.save();
  };

  return {
    front: await build(fronts, first === "EVEN"),
    back: await build(backs, first === "ODD"),
    frontSheets: fronts.length,
    backSheets: backs.length,
    padded: count % 2 === 1,
  };
}
