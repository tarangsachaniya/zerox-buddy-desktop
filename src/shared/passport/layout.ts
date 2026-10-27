import type { PaperMm } from "./paper";

/**
 * The passport sheet layout engine. Pure, millimetres throughout, origin at
 * the sheet's top-left with y going down. The renderer preview, the exported
 * PDF and the printed PDF all come from the same result, so what the operator
 * sees is what prints.
 *
 * Photos are never shrunk to fit more on a sheet: a layout that can't hold
 * one photo at its real size is an error, and a quantity that doesn't fit on
 * one sheet spills onto more sheets.
 */

export type Margins = { top: number; right: number; bottom: number; left: number };

export type LayoutMode = "AUTO_FIT" | "TARGET";
export type GridAlign = "CENTER" | "TOP_LEFT";

export type SheetSpec = {
  /** The sheet as laid out (already turned for landscape). */
  paper: PaperMm;
  photo: { widthMm: number; heightMm: number };
  margins: Margins;
  gapXMm: number;
  gapYMm: number;
  align: GridAlign;
  mode: LayoutMode;
  /** TARGET: how many photos in total. Ignored for AUTO_FIT (one full sheet). */
  copies: number;
  /**
   * Cut-out border. `paddingMm` is white space between the photo and the cut
   * line (0.5 mm in the shop's Word layouts): with it each cell is a frame of
   * photo + 2 × padding, and the photo sits centred inside it.
   */
  border: { enabled: boolean; thicknessMm: number; paddingMm?: number };
  /**
   * What the printer can't reach, in the same orientation as `paper`. Each
   * margin is raised to at least this, so nothing lands off the printable area.
   */
  hardMargins?: Margins | null;
};

export type Cell = { x: number; y: number; w: number; h: number };

export type SheetLayout = {
  paper: PaperMm;
  /** The margins used: the operator's, raised to the printer's hard margins. */
  margins: Margins;
  printable: Cell;
  cols: number;
  rows: number;
  perSheet: number;
  requested: number;
  sheets: number;
  /** Cells (frames) per sheet; the last sheet of a TARGET layout holds only the remainder. */
  pages: Cell[][];
  /** How far the photo sits inside each cell, on every side (the border's white gap; 0 without one). */
  insetMm: number;
  /** Problems that stop the sheet from being made; empty when it's fine. */
  errors: string[];
  fitsOnOneSheet: boolean;
};

export const MAX_COPIES = 500;
export const MAX_SHEETS = 50;
export const MAX_BORDER_MM = 5;
export const MAX_PADDING_MM = 5;
const EPS = 1e-6;

export const ZERO_MARGINS: Margins = { top: 0, right: 0, bottom: 0, left: 0 };

function finiteNonNegative(n: number): boolean {
  return Number.isFinite(n) && n >= 0;
}

/** How many items of `size` with `gap` between them fit in `span`. */
export function fitCount(span: number, size: number, gap: number): number {
  if (!(size > 0) || span < size - EPS) return 0;
  return Math.floor((span + gap + EPS) / (size + gap));
}

export function effectiveMargins(margins: Margins, hard?: Margins | null): Margins {
  if (!hard) return { ...margins };
  return {
    top: Math.max(margins.top, hard.top),
    right: Math.max(margins.right, hard.right),
    bottom: Math.max(margins.bottom, hard.bottom),
    left: Math.max(margins.left, hard.left),
  };
}

export function computeSheetLayout(spec: SheetSpec): SheetLayout {
  const errors: string[] = [];
  const { paper, photo } = spec;
  const margins = effectiveMargins(spec.margins, spec.hardMargins);
  const base: SheetLayout = {
    paper,
    margins,
    printable: { x: margins.left, y: margins.top, w: 0, h: 0 },
    cols: 0,
    rows: 0,
    perSheet: 0,
    requested: 0,
    sheets: 0,
    pages: [],
    insetMm: 0,
    errors: [],
    fitsOnOneSheet: false,
  };

  if (!(paper.widthMm > 0) || !(paper.heightMm > 0)) errors.push("Paper width and height must be more than 0 mm");
  if (!(photo.widthMm > 0) || !(photo.heightMm > 0)) errors.push("Photo width and height must be more than 0 mm");
  if (![margins.top, margins.right, margins.bottom, margins.left].every(finiteNonNegative)) errors.push("Margins can't be negative");
  if (!finiteNonNegative(spec.gapXMm) || !finiteNonNegative(spec.gapYMm)) errors.push("Spacing can't be negative");
  if (spec.border.enabled && !(spec.border.thicknessMm > 0 && spec.border.thicknessMm <= MAX_BORDER_MM)) {
    errors.push(`Border thickness must be more than 0 and at most ${MAX_BORDER_MM} mm`);
  }
  const padding = spec.border.enabled ? (spec.border.paddingMm ?? 0) : 0;
  if (!(Number.isFinite(padding) && padding >= 0 && padding <= MAX_PADDING_MM)) errors.push(`The gap inside the border must be 0 to ${MAX_PADDING_MM} mm`);
  if (spec.mode === "TARGET" && !(Number.isInteger(spec.copies) && spec.copies >= 1 && spec.copies <= MAX_COPIES)) {
    errors.push(`Number of copies must be a whole number from 1 to ${MAX_COPIES}`);
  }
  if (errors.length) return { ...base, errors };

  const printable: Cell = {
    x: margins.left,
    y: margins.top,
    w: paper.widthMm - margins.left - margins.right,
    h: paper.heightMm - margins.top - margins.bottom,
  };
  if (printable.w <= 0 || printable.h <= 0) return { ...base, errors: ["The margins leave no room on the paper"] };

  // What's laid out: the photo, or its frame when the border has a white gap.
  const cellW = photo.widthMm + 2 * padding;
  const cellH = photo.heightMm + 2 * padding;
  const cols = fitCount(printable.w, cellW, spec.gapXMm);
  const rows = fitCount(printable.h, cellH, spec.gapYMm);
  if (cols < 1 || rows < 1) {
    const what = padding > 0 ? `framed ${fmt(cellW)} × ${fmt(cellH)} mm` : "";
    return {
      ...base,
      printable,
      errors: [
        `A ${fmt(photo.widthMm)} × ${fmt(photo.heightMm)} mm photo${what ? ` (${what})` : ""} doesn't fit inside the ${fmt(printable.w)} × ${fmt(printable.h)} mm printable area`,
      ],
    };
  }
  const perSheet = cols * rows;
  const requested = spec.mode === "AUTO_FIT" ? perSheet : spec.copies;
  const sheets = Math.ceil(requested / perSheet);
  if (sheets > MAX_SHEETS) {
    return { ...base, printable, cols, rows, perSheet, requested, sheets, errors: [`That needs ${sheets} sheets; the most in one go is ${MAX_SHEETS}`] };
  }

  const gridW = cols * cellW + (cols - 1) * spec.gapXMm;
  const gridH = rows * cellH + (rows - 1) * spec.gapYMm;
  // Centred on the paper itself (what the eye judges), moved only as far as
  // needed to stay inside the printable box when the margins are uneven.
  const centre = (paperSpan: number, start: number, span: number, grid: number) =>
    Math.min(Math.max((paperSpan - grid) / 2, start), start + span - grid);
  const x0 = spec.align === "CENTER" ? centre(paper.widthMm, printable.x, printable.w, gridW) : printable.x;
  const y0 = spec.align === "CENTER" ? centre(paper.heightMm, printable.y, printable.h, gridH) : printable.y;

  const full: Cell[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      full.push({
        x: x0 + c * (cellW + spec.gapXMm),
        y: y0 + r * (cellH + spec.gapYMm),
        w: cellW,
        h: cellH,
      });
    }
  }
  const pages: Cell[][] = [];
  let remaining = requested;
  for (let s = 0; s < sheets; s++) {
    pages.push(full.slice(0, Math.min(perSheet, remaining)));
    remaining -= perSheet;
  }

  return { paper, margins, printable, cols, rows, perSheet, requested, sheets, pages, insetMm: padding, errors: [], fitsOnOneSheet: requested <= perSheet };
}

function fmt(n: number): string {
  return String(Math.round(n * 10) / 10);
}

/**
 * Hard margins as Windows reports them (for the portrait page) turned to
 * match a landscape layout. A landscape sheet prints turned a quarter-turn
 * clockwise inside the portrait page, so its left edge lies along the page's
 * top, its top along the page's right, and so on.
 */
export function orientHardMargins(portrait: Margins, landscape: boolean): Margins {
  if (!landscape) return { ...portrait };
  return { left: portrait.top, top: portrait.right, right: portrait.bottom, bottom: portrait.left };
}
