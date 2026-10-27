import type { DuplexFlip, Orientation, PaperSize, PrintType } from "../../shared/types";

/**
 * Builds SumatraPDF's `-print-settings` string for one file of a job. Pure.
 *
 *   "1-5,8,2x,duplexlong,monochrome,paper=A4,portrait,fit"
 *
 * Page ranges come from the customer's selection, which the API has already
 * validated against the real page count; they're normalised here (spaces
 * dropped) and anything unexpected is refused rather than passed to a
 * command line.
 */

export type PrintOptions = {
  pageRanges: string | null;
  copies: number;
  duplex: boolean;
  printType: PrintType | null;
  paperSize: PaperSize | null;
  orientation: Orientation;
  /** Images have one page and no ranges. */
  isImage: boolean;
  duplexFlip?: DuplexFlip;
  /**
   * The file is the output of layout.ts: ranges/scale/margins/orientation are
   * already applied on portrait-shaped sheets, so print it as-is.
   */
  prelaid?: boolean;
  /**
   * Prelaid and must print at 100% (passport photos): `noscale` instead of
   * `fit`. SumatraPDF then pins the page to the printable area's corner, so
   * the PDF is drawn already shifted back by the printer's hard margins
   * (passport/pdf.ts) and lands at its true position and size.
   */
  exact?: boolean;
  /**
   * Exact prints on a paper SumatraPDF can't name (4×6): the driver's own name
   * for it. SumatraPDF matches it against the printer's paper list; without it
   * SumatraPDF picks a paper itself (Letter) and the printer refuses the job.
   */
  driverPaper?: string | null;
};

const RANGES = /^\d+(-\d+)?(,\d+(-\d+)?)*$/;

export function normaliseRanges(raw: string | null): string | null {
  if (!raw) return null;
  const compact = raw.replace(/\s+/g, "");
  if (!compact) return null;
  if (!RANGES.test(compact)) throw new Error(`Unexpected page selection "${raw}"`);
  return compact;
}

/** Paper names SumatraPDF's -print-settings understands; any other name is silently ignored by it. */
const SUMATRA_PAPER: Record<string, string> = { A2: "A2", A3: "A3", A4: "A4", A5: "A5", A6: "A6", LETTER: "letter", LEGAL: "legal", TABLOID: "tabloid", STATEMENT: "statement" };

export function sumatraKnowsPaper(paperSize: string | null): boolean {
  return !!paperSize && paperSize.toUpperCase() in SUMATRA_PAPER;
}

/** A driver paper name as a -print-settings value; refused if it would break the comma-separated list. */
export function driverPaperSetting(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || /[,\u0000-\u001f"]/.test(trimmed)) throw new Error(`The printer's paper name "${name}" can't be passed to SumatraPDF`);
  return trimmed;
}

export function sumatraSettings(opts: PrintOptions): string {
  const copies = Math.min(99, Math.max(1, Math.floor(opts.copies)));
  const parts: string[] = [];
  const ranges = opts.isImage || opts.prelaid ? null : normaliseRanges(opts.pageRanges);
  if (ranges) parts.push(ranges);
  parts.push(`${copies}x`);
  parts.push(opts.duplex ? (opts.duplexFlip === "SHORT" ? "duplexshort" : "duplexlong") : "simplex");
  parts.push(opts.printType === "COLOR" ? "color" : "monochrome");
  parts.push(`paper=${opts.paperSize ?? "A4"}`);
  if (opts.exact) {
    if (sumatraKnowsPaper(opts.paperSize)) parts[parts.length - 1] = `paper=${SUMATRA_PAPER[(opts.paperSize ?? "A4").toUpperCase()]}`;
    else if (opts.driverPaper) parts[parts.length - 1] = `paper=${driverPaperSetting(opts.driverPaper)}`;
    else parts.pop();
    parts.push("portrait", "noscale");
    return parts.join(",");
  }
  if (opts.prelaid) {
    // Landscape content is already turned inside a portrait sheet (layout.ts),
    // so the driver never has to rotate anything. The sheet is exactly the
    // paper size; `fit` shrinks it into the printer's printable area and
    // centres it, as a PC print does. `noscale` pinned it to the printable
    // area's corner, shifting it by the hardware margin and cutting the far
    // edges off.
    parts.push("portrait", "fit");
    return parts.join(",");
  }
  // Without an explicit orientation, SumatraPDF prints portrait regardless of
  // the source page's own shape — a landscape document then gets scaled to
  // fit a portrait bounding box and can come out blank or badly clipped.
  parts.push(opts.orientation === "LANDSCAPE" ? "landscape" : "portrait");
  // Scale to the printable area so nothing is clipped; photos keep their ratio.
  parts.push("fit");
  return parts.join(",");
}
