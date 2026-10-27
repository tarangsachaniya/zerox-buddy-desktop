import { computeSheetLayout, orientHardMargins, type GridAlign, type LayoutMode, type Margins, type SheetLayout } from "./layout";
import { isPassportPaperCode, resolvePaper, type PaperMm, type PassportPaperCode, type SheetOrientation } from "./paper";

/**
 * Everything the operator sets for a passport sheet — what the renderer sends
 * to main to export or print. Main re-checks it (parseSheetSettings) rather
 * than trusting the renderer, then both sides lay it out with the same
 * engine, so the preview and the paper agree.
 */
export type PassportSheetSettings = {
  paperSize: PassportPaperCode;
  customPaper: PaperMm | null;
  orientation: SheetOrientation;
  photo: { widthMm: number; heightMm: number };
  margins: Margins;
  gapXMm: number;
  gapYMm: number;
  align: GridAlign;
  mode: LayoutMode;
  /** TARGET: photos wanted in total. */
  copies: number;
  border: { enabled: boolean; thicknessMm: number; paddingMm: number };
};

export const DPI_CHOICES = [300, 600, 1200] as const;

function num(v: unknown, field: string): number {
  const n = typeof v === "number" ? v : Number.NaN;
  if (!Number.isFinite(n)) throw new Error(`${field} must be a number`);
  return n;
}

/** Checks settings from the renderer; throws with a message the operator can act on. */
export function parseSheetSettings(raw: unknown): PassportSheetSettings {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (!isPassportPaperCode(r.paperSize)) throw new Error("Choose A4, 4 × 6 in or a custom paper size");
  const orientation = r.orientation === "LANDSCAPE" ? "LANDSCAPE" : "PORTRAIT";
  const photo = (r.photo ?? {}) as Record<string, unknown>;
  const margins = (r.margins ?? {}) as Record<string, unknown>;
  const border = (r.border ?? {}) as Record<string, unknown>;
  const custom = r.customPaper as Record<string, unknown> | null | undefined;
  return {
    paperSize: r.paperSize,
    customPaper:
      r.paperSize === "CUSTOM" && custom ? { widthMm: num(custom.widthMm, "Paper width"), heightMm: num(custom.heightMm, "Paper height") } : null,
    orientation,
    photo: { widthMm: num(photo.widthMm, "Photo width"), heightMm: num(photo.heightMm, "Photo height") },
    margins: {
      top: num(margins.top, "Top margin"),
      right: num(margins.right, "Right margin"),
      bottom: num(margins.bottom, "Bottom margin"),
      left: num(margins.left, "Left margin"),
    },
    gapXMm: num(r.gapXMm, "Horizontal spacing"),
    gapYMm: num(r.gapYMm, "Vertical spacing"),
    align: r.align === "TOP_LEFT" ? "TOP_LEFT" : "CENTER",
    mode: r.mode === "TARGET" ? "TARGET" : "AUTO_FIT",
    copies: Math.floor(num(r.copies ?? 1, "Copies")),
    border: {
      enabled: border.enabled === true,
      thicknessMm: num(border.thicknessMm ?? 0.2, "Border thickness"),
      paddingMm: num(border.paddingMm ?? 0, "Gap inside the border"),
    },
  };
}

/**
 * Lays the sheet out. `portraitHardMargins` are the printer's, as Windows
 * reports them for the portrait page; they're turned for a landscape sheet.
 * A bad paper size comes back as a layout error rather than a throw, so the
 * preview can show it.
 */
export function layoutSheet(settings: PassportSheetSettings, portraitHardMargins?: Margins | null): SheetLayout {
  let paper: PaperMm;
  try {
    paper = resolvePaper(settings.paperSize, settings.orientation, settings.customPaper);
  } catch (err) {
    return { ...emptyLayout(), errors: [err instanceof Error ? err.message : "Unsupported paper size"] };
  }
  return computeSheetLayout({
    paper,
    photo: settings.photo,
    margins: settings.margins,
    gapXMm: settings.gapXMm,
    gapYMm: settings.gapYMm,
    align: settings.align,
    mode: settings.mode,
    copies: settings.copies,
    border: settings.border,
    hardMargins: portraitHardMargins ? orientHardMargins(portraitHardMargins, settings.orientation === "LANDSCAPE") : null,
  });
}

function emptyLayout(): SheetLayout {
  const zero = { top: 0, right: 0, bottom: 0, left: 0 };
  return {
    paper: { widthMm: 0, heightMm: 0 },
    margins: zero,
    printable: { x: 0, y: 0, w: 0, h: 0 },
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
}
