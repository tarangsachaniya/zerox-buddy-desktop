import type { SheetLayout } from "./layout";

/**
 * Where each photo goes on the page that is actually printed. Printers feed
 * portrait, so a landscape sheet is turned a quarter-turn clockwise inside a
 * portrait page (its left edge along the page's top); a portrait sheet is
 * printed as laid out. Millimetres, origin top-left, y down. Pure.
 */

export type PrintBox = {
  x: number;
  y: number;
  /** The photo's footprint on the page (sides swapped when turned). */
  w: number;
  h: number;
  /** 90: the photo is drawn turned clockwise inside the box. */
  rotation: 0 | 90;
};

export function printPage(layout: SheetLayout): { widthMm: number; heightMm: number; turned: boolean } {
  const turned = layout.paper.widthMm > layout.paper.heightMm;
  return turned
    ? { widthMm: layout.paper.heightMm, heightMm: layout.paper.widthMm, turned }
    : { widthMm: layout.paper.widthMm, heightMm: layout.paper.heightMm, turned };
}

export function printBoxes(layout: SheetLayout, page: number): PrintBox[] {
  const { turned } = printPage(layout);
  return (layout.pages[page] ?? []).map((c) =>
    turned ? { x: layout.paper.heightMm - c.y - c.h, y: c.x, w: c.h, h: c.w, rotation: 90 as const } : { ...c, rotation: 0 as const },
  );
}
