import { PDFDocument } from "pdf-lib";
import { describe, expect, test } from "vitest";

import { buildPrintPdf, expandRanges, gridFor, paperMm, placeInFrame } from "./layout";
import type { LayoutOptions } from "./layout";

const base: LayoutOptions = { paperSize: "A4", orientation: "AUTO", scaleMode: "FIT", margins: "DEFAULT", bleedMm: 0, pagesPerSheet: 1 };

async function pdf(pages: [number, number][]): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  for (const p of pages) d.addPage(p);
  return d.save();
}
const src = async (pages: [number, number][], pageRanges: string | null = null) => ({
  bytes: await pdf(pages),
  isImage: false,
  mimeType: "application/pdf",
  pageRanges,
});

describe("geometry", () => {
  test("paper lookup falls back to A4", () => {
    expect(paperMm("A3")).toEqual([297, 420]);
    expect(paperMm("PHOTO_4X6")).toEqual([101.6, 152.4]);
    expect(paperMm("MYSTERY")).toEqual([210, 297]);
  });
  test("ranges expand and clamp", () => {
    expect(expandRanges("1-3,5", 4)).toEqual([1, 2, 3]);
    expect(expandRanges(null, 2)).toEqual([1, 2]);
  });
  test("grid flips for landscape", () => {
    expect(gridFor(2, "PORTRAIT")).toEqual({ cols: 1, rows: 2 });
    expect(gridFor(2, "LANDSCAPE")).toEqual({ cols: 2, rows: 1 });
    expect(gridFor(6, "LANDSCAPE")).toEqual({ cols: 3, rows: 2 });
  });
  test("fit vs fill vs actual", () => {
    const frame = { x: 0, y: 0, w: 200, h: 100 };
    const item = { w: 100, h: 100 };
    expect(placeInFrame(item, frame, "FIT")).toEqual({ x: 50, y: 0, w: 100, h: 100 });
    expect(placeInFrame(item, frame, "FILL")).toEqual({ x: 0, y: -50, w: 200, h: 200 });
    expect(placeInFrame(item, frame, "ACTUAL")).toEqual({ x: 50, y: 0, w: 100, h: 100 });
  });
});

describe("buildPrintPdf", () => {
  test("AUTO turns a landscape page into a landscape sheet", async () => {
    const r = await buildPrintPdf([await src([[800, 400]])], base);
    const out = await PDFDocument.load(r.bytes);
    const { width, height } = out.getPage(0).getSize();
    expect(width).toBeGreaterThan(height);
    expect(r.uniformOrientation).toBe("LANDSCAPE");
  });
  test("mixed orientations are reported as mixed", async () => {
    const r = await buildPrintPdf([await src([[800, 400], [400, 800]])], base);
    expect(r.sheets).toBe(2);
    expect(r.uniformOrientation).toBeNull();
  });
  test("explicit orientation overrides the page shape", async () => {
    const r = await buildPrintPdf([await src([[800, 400]])], { ...base, orientation: "PORTRAIT" });
    expect(r.uniformOrientation).toBe("PORTRAIT");
  });
  test("pages per sheet and page ranges", async () => {
    const r = await buildPrintPdf([await src([[400, 800], [400, 800], [400, 800], [400, 800], [400, 800]], "1-4")], { ...base, pagesPerSheet: 2 });
    expect(r.sheets).toBe(2);
  });
});
