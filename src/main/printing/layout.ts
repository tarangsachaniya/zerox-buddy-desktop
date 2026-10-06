import { PDFDocument, clip, endPath, popGraphicsState, pushGraphicsState, rectangle } from "pdf-lib";
import type { PDFEmbeddedPage, PDFImage, PDFPage } from "pdf-lib";

import type { Margins, Orientation, PaperSize, ScaleMode } from "../../shared/types";

/**
 * Lays a job's files out onto print-ready sheets (one PDF) so the shop's
 * printer gets exactly what the customer chose — orientation per page,
 * fit/fill/actual scaling, margins, bleed and pages-per-sheet — instead of
 * relying on SumatraPDF/driver flags. The result is printed with `noscale`.
 */

export type LayoutOptions = {
  paperSize: PaperSize | null;
  orientation: Orientation;
  scaleMode: ScaleMode;
  margins: Margins;
  bleedMm: number;
  pagesPerSheet: number;
};

export type LayoutSource = {
  bytes: Uint8Array;
  isImage: boolean;
  mimeType: string;
  /** Normalised page selection (PDF only); null = all pages. */
  pageRanges: string | null;
};

export type LayoutResult = {
  bytes: Uint8Array;
  sheets: number;
  /** Set when every sheet has the same orientation, else null (mixed). */
  uniformOrientation: "PORTRAIT" | "LANDSCAPE" | null;
};

const PT_PER_MM = 72 / 25.4;
const MARGIN_MM: Record<Margins, number> = { DEFAULT: 5, MINIMUM: 2, NONE: 0 };

/** Portrait width × height in mm for the catalog codes we know; others use A4. */
const PAPER_MM: [RegExp, [number, number]][] = [
  [/^A3$/, [297, 420]],
  [/^A4$/, [210, 297]],
  [/^A5$/, [148, 210]],
  [/^A6$/, [105, 148]],
  [/^B4$/, [250, 353]],
  [/^B5$/, [176, 250]],
  [/^LETTER$/, [215.9, 279.4]],
  [/^LEGAL$/, [215.9, 355.6]],
  [/4X6/, [101.6, 152.4]],
  [/5X7/, [127, 177.8]],
];

export function isThermal(paperSize: PaperSize | null): boolean {
  return !!paperSize && paperSize.toUpperCase().startsWith("THERMAL");
}

export function paperMm(paperSize: PaperSize | null): [number, number] {
  const code = (paperSize ?? "A4").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return PAPER_MM.find(([re]) => re.test(code))?.[1] ?? [210, 297];
}

/** Expands "1-3,5" into [1,2,3,5], clamped to the document's page count. */
export function expandRanges(ranges: string | null, pageCount: number): number[] {
  if (!ranges) return Array.from({ length: pageCount }, (_, i) => i + 1);
  const out: number[] = [];
  for (const part of ranges.split(",")) {
    const [a, b] = part.split("-").map(Number) as [number, number | undefined];
    const end = b ?? a;
    for (let n = a; n <= end; n++) if (n >= 1 && n <= pageCount) out.push(n);
  }
  return out;
}

export function gridFor(perSheet: number, orientation: "PORTRAIT" | "LANDSCAPE"): { cols: number; rows: number } {
  const g: Record<number, [number, number]> = { 1: [1, 1], 2: [1, 2], 4: [2, 2], 6: [2, 3], 9: [3, 3] };
  const [cols, rows] = g[perSheet] ?? [1, 1];
  return orientation === "LANDSCAPE" ? { cols: rows, rows: cols } : { cols, rows };
}

export type Frame = { x: number; y: number; w: number; h: number };

/** Where a w×h item is drawn inside a frame (PDF coordinates, y up). */
export function placeInFrame(item: { w: number; h: number }, frame: Frame, mode: ScaleMode): Frame {
  const scale =
    mode === "ACTUAL" ? 1 : mode === "FILL" ? Math.max(frame.w / item.w, frame.h / item.h) : Math.min(frame.w / item.w, frame.h / item.h);
  const w = item.w * scale;
  const h = item.h * scale;
  return { x: frame.x + (frame.w - w) / 2, y: frame.y + (frame.h - h) / 2, w, h };
}

type Item = { w: number; h: number; draw: (page: PDFPage, at: Frame) => void };

async function loadItems(out: PDFDocument, sources: LayoutSource[]): Promise<Item[]> {
  const items: Item[] = [];
  for (const src of sources) {
    if (src.isImage) {
      const img: PDFImage = src.mimeType === "image/png" ? await out.embedPng(src.bytes) : await out.embedJpg(src.bytes);
      // Pixels at 96 dpi, so ACTUAL size matches what a Ctrl+P preview shows.
      items.push({
        w: (img.width * 72) / 96,
        h: (img.height * 72) / 96,
        draw: (page, at) => page.drawImage(img, { x: at.x, y: at.y, width: at.w, height: at.h }),
      });
      continue;
    }
    const doc = await PDFDocument.load(src.bytes, { ignoreEncryption: true });
    const wanted = expandRanges(src.pageRanges, doc.getPageCount());
    for (const n of wanted) {
      const pdfPage = doc.getPage(n - 1);
      const { width, height } = pdfPage.getSize();
      let ep: PDFEmbeddedPage | null = null;
      // A blank page has no content stream (pdf-lib can't embed it, and fails
      // only at save time): leave it as a blank sheet.
      if (pdfPage.node.Contents()) [ep] = await out.embedPdf(doc, [n - 1]);
      items.push(ep ? { w: ep.width, h: ep.height, draw: (page, at) => page.drawPage(ep!, { x: at.x, y: at.y, width: at.w, height: at.h }) } : { w: width, h: height, draw: () => {} });
    }
  }
  return items;
}

export async function buildPrintPdf(sources: LayoutSource[], opts: LayoutOptions): Promise<LayoutResult> {
  const out = await PDFDocument.create();
  const items = await loadItems(out, sources);
  const perSheet = Math.max(1, opts.pagesPerSheet);
  const [pw, ph] = paperMm(opts.paperSize).map((mm) => mm * PT_PER_MM) as [number, number];
  const margin = MARGIN_MM[opts.margins] * PT_PER_MM;
  const bleed = (perSheet === 1 ? opts.bleedMm : 0) * PT_PER_MM;

  const orientations = new Set<"PORTRAIT" | "LANDSCAPE">();
  for (let i = 0; i < items.length; i += perSheet) {
    const group = items.slice(i, i + perSheet);
    const first = group[0]!;
    const orientation: "PORTRAIT" | "LANDSCAPE" =
      opts.orientation === "AUTO" ? (first.w > first.h ? "LANDSCAPE" : "PORTRAIT") : opts.orientation;
    orientations.add(orientation);
    const [sw, sh] = orientation === "LANDSCAPE" ? [ph, pw] : [pw, ph];
    const page = out.addPage([sw, sh]);

    const { cols, rows } = gridFor(perSheet, orientation);
    const cw = (sw - margin * 2) / cols;
    const ch = (sh - margin * 2) / rows;
    group.forEach((item, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const frame: Frame = {
        x: margin + col * cw - bleed,
        y: sh - margin - (row + 1) * ch - bleed,
        w: cw + bleed * 2,
        h: ch + bleed * 2,
      };
      // Clip to the frame so FILL / ACTUAL never spill into neighbouring cells.
      page.pushOperators(pushGraphicsState(), rectangle(frame.x, frame.y, frame.w, frame.h), clip(), endPath());
      item.draw(page, placeInFrame(item, frame, opts.scaleMode));
      page.pushOperators(popGraphicsState());
    });
  }

  if (out.getPageCount() === 0) throw new Error("Nothing to print");
  return {
    bytes: await out.save(),
    sheets: out.getPageCount(),
    uniformOrientation: orientations.size === 1 ? [...orientations][0]! : null,
  };
}
