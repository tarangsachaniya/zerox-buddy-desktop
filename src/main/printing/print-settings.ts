import type { Orientation, PaperSize, PrintType } from "../../shared/types";

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
};

const RANGES = /^\d+(-\d+)?(,\d+(-\d+)?)*$/;

export function normaliseRanges(raw: string | null): string | null {
  if (!raw) return null;
  const compact = raw.replace(/\s+/g, "");
  if (!compact) return null;
  if (!RANGES.test(compact)) throw new Error(`Unexpected page selection "${raw}"`);
  return compact;
}

export function sumatraSettings(opts: PrintOptions): string {
  const copies = Math.min(99, Math.max(1, Math.floor(opts.copies)));
  const parts: string[] = [];
  const ranges = opts.isImage ? null : normaliseRanges(opts.pageRanges);
  if (ranges) parts.push(ranges);
  parts.push(`${copies}x`);
  parts.push(opts.duplex ? "duplexlong" : "simplex");
  parts.push(opts.printType === "COLOR" ? "color" : "monochrome");
  parts.push(`paper=${opts.paperSize ?? "A4"}`);
  // Without an explicit orientation, SumatraPDF prints portrait regardless of
  // the source page's own shape — a landscape document then gets scaled to
  // fit a portrait bounding box and can come out blank or badly clipped.
  parts.push(opts.orientation === "LANDSCAPE" ? "landscape" : "portrait");
  // Scale to the printable area so nothing is clipped; photos keep their ratio.
  parts.push("fit");
  return parts.join(",");
}
