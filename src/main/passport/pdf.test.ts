import { decodePDFRawStream, PDFArray, PDFDocument, PDFRawStream } from "pdf-lib";
import type { PDFPage } from "pdf-lib";
import { describe, expect, test } from "vitest";

import { layoutSheet, type PassportSheetSettings } from "../../shared/passport/sheet";
import { mmToPt } from "../../shared/passport/units";
import { buildPassportPdf } from "./pdf";

/** A 30 × 20 px JPEG (from compose.test.ts). */
const BASE = Uint8Array.from(
  atob(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAKBueIx4ZKCMgoy0qqC+8P//8Nzc8P//////////////////////////////////////////////////////////wAALCAAUAB4BAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/ACiiiiiiiiiiiv/Z",
  ),
  (c) => c.charCodeAt(0),
);

/** The same JPEG claiming another pixel size in its frame header (pdf-lib only reads the header). */
function jpegSized(width: number, height: number): Uint8Array {
  const b = BASE.slice();
  for (let i = 2; i < b.length - 9; i++) {
    if (b[i] === 0xff && b[i + 1] === 0xc0) {
      b[i + 5] = height >> 8;
      b[i + 6] = height & 0xff;
      b[i + 7] = width >> 8;
      b[i + 8] = width & 0xff;
      return b;
    }
  }
  throw new Error("no SOF0 in test JPEG");
}

const PHOTO_300 = jpegSized(413, 531);
const PHOTO_600 = jpegSized(827, 1063);

function settings(over: Partial<PassportSheetSettings> = {}): PassportSheetSettings {
  return {
    paperSize: "A4",
    customPaper: null,
    orientation: "PORTRAIT",
    photo: { widthMm: 35, heightMm: 45 },
    margins: { top: 5, right: 5, bottom: 5, left: 5 },
    gapXMm: 2,
    gapYMm: 2,
    align: "CENTER",
    mode: "AUTO_FIT",
    copies: 1,
    border: { enabled: false, thicknessMm: 0.2 },
    ...over,
  };
}

type M = [number, number, number, number, number, number];
type Box = { x: number; y: number; w: number; h: number };

const IDENTITY: M = [1, 0, 0, 1, 0, 0];

/** m applied first, then c (PDF's `cm` premultiplies the current matrix). */
function concat(m: M, c: M): M {
  return [m[0] * c[0] + m[1] * c[2], m[0] * c[1] + m[1] * c[3], m[2] * c[0] + m[3] * c[2], m[2] * c[1] + m[3] * c[3], m[4] * c[0] + m[5] * c[2] + c[4], m[4] * c[1] + m[5] * c[3] + c[5]];
}

function contentText(doc: PDFDocument, page: PDFPage): string {
  const contents = page.node.Contents();
  const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
  return refs
    .map((ref) => {
      const stream = doc.context.lookup(ref as never);
      if (!(stream instanceof PDFRawStream)) throw new Error("unexpected content stream");
      return Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1");
    })
    .join("\n");
}

/** Every drawn image's box on the page, in points, from replaying q / Q / cm / Do. */
function imageBoxes(text: string): Box[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  const stack: M[] = [];
  let ctm: M = IDENTITY;
  const operands: string[] = [];
  const boxes: Box[] = [];
  for (const t of tokens) {
    if (t === "q") stack.push(ctm);
    else if (t === "Q") ctm = stack.pop() ?? IDENTITY;
    else if (t === "cm") ctm = concat(operands.slice(-6).map(Number) as M, ctm);
    else if (t === "Do") {
      const pts = [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ].map(([x, y]) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]]);
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      boxes.push({ x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) });
    }
    if (/^[-+.\d]/.test(t) || t.startsWith("/")) operands.push(t);
    else operands.length = 0;
  }
  return boxes;
}

async function load(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  return { doc, pages: doc.getPages() };
}

describe("buildPassportPdf: page sizes", () => {
  test("A4 portrait and landscape are exactly 210 × 297 mm", async () => {
    for (const orientation of ["PORTRAIT", "LANDSCAPE"] as const) {
      const s = settings({ orientation });
      const { bytes } = await buildPassportPdf(PHOTO_300, layoutSheet(s), { forPrint: false, border: s.border });
      const { width, height } = (await load(bytes)).pages[0].getSize();
      const expected = orientation === "PORTRAIT" ? [595.28, 841.89] : [841.89, 595.28];
      expect(width).toBeCloseTo(expected[0], 1);
      expect(height).toBeCloseTo(expected[1], 1);
    }
  });

  test("4 × 6 in is exactly 288 × 432 pt, either way round", async () => {
    for (const orientation of ["PORTRAIT", "LANDSCAPE"] as const) {
      const s = settings({ paperSize: "4X6", orientation, margins: { top: 3, right: 3, bottom: 3, left: 3 } });
      const { bytes } = await buildPassportPdf(PHOTO_300, layoutSheet(s), { forPrint: false, border: s.border });
      const { width, height } = (await load(bytes)).pages[0].getSize();
      const expected = orientation === "PORTRAIT" ? [288, 432] : [432, 288];
      expect(width).toBeCloseTo(expected[0], 3);
      expect(height).toBeCloseTo(expected[1], 3);
    }
  });

  test("a print PDF is always portrait, even for a landscape sheet", async () => {
    const s = settings({ orientation: "LANDSCAPE" });
    const { bytes } = await buildPassportPdf(PHOTO_300, layoutSheet(s), { forPrint: true, border: s.border });
    const { width, height } = (await load(bytes)).pages[0].getSize();
    expect([Math.round(width), Math.round(height)]).toEqual([595, 842]);
  });
});

describe("buildPassportPdf: photo placement", () => {
  test("every photo is drawn at exactly 35 × 45 mm where the layout put it", async () => {
    const s = settings();
    const layout = layoutSheet(s);
    const { bytes, sheets } = await buildPassportPdf(PHOTO_300, layout, { forPrint: false, border: s.border });
    expect(sheets).toBe(1);
    const { doc, pages } = await load(bytes);
    const boxes = imageBoxes(contentText(doc, pages[0]));
    expect(boxes).toHaveLength(30);
    const pageH = mmToPt(297);
    boxes.forEach((b, i) => {
      const c = layout.pages[0][i];
      expect(b.w).toBeCloseTo(mmToPt(35), 3);
      expect(b.h).toBeCloseTo(mmToPt(45), 3);
      expect(b.x).toBeCloseTo(mmToPt(c.x), 3);
      expect(b.y).toBeCloseTo(pageH - mmToPt(c.y + c.h), 3);
    });
  });

  test("the printed size doesn't depend on the photo's pixel count (DPI)", async () => {
    const s = settings({ mode: "TARGET", copies: 4 });
    const layout = layoutSheet(s);
    const at300 = await buildPassportPdf(PHOTO_300, layout, { forPrint: false, border: s.border });
    const at600 = await buildPassportPdf(PHOTO_600, layout, { forPrint: false, border: s.border });
    const a = await load(at300.bytes);
    const b = await load(at600.bytes);
    const boxes300 = imageBoxes(contentText(a.doc, a.pages[0]));
    const boxes600 = imageBoxes(contentText(b.doc, b.pages[0]));
    expect(boxes300).toHaveLength(4);
    boxes300.forEach((box, i) => {
      expect(box.w).toBeCloseTo(boxes600[i].w, 6);
      expect(box.h).toBeCloseTo(boxes600[i].h, 6);
      expect(box.x).toBeCloseTo(boxes600[i].x, 6);
      expect(box.y).toBeCloseTo(boxes600[i].y, 6);
    });
  });

  test("a quantity over one sheet makes more pages, the remainder on the last", async () => {
    const s = settings({ mode: "TARGET", copies: 65 });
    const { bytes, sheets } = await buildPassportPdf(PHOTO_300, layoutSheet(s), { forPrint: false, border: s.border });
    expect(sheets).toBe(3);
    const { doc, pages } = await load(bytes);
    expect(pages.map((p) => imageBoxes(contentText(doc, p)).length)).toEqual([30, 30, 5]);
  });

  test("a landscape sheet printed turned keeps each photo 35 × 45 mm, now sideways", async () => {
    const s = settings({ orientation: "LANDSCAPE", mode: "TARGET", copies: 3 });
    const layout = layoutSheet(s);
    const { bytes } = await buildPassportPdf(PHOTO_300, layout, { forPrint: true, border: s.border });
    const { doc, pages } = await load(bytes);
    const boxes = imageBoxes(contentText(doc, pages[0]));
    const pageH = mmToPt(297);
    boxes.forEach((b, i) => {
      const c = layout.pages[0][i];
      expect(b.w).toBeCloseTo(mmToPt(45), 3);
      expect(b.h).toBeCloseTo(mmToPt(35), 3);
      // Landscape (x, y) lands at portrait (210 − y − h, x).
      expect(b.x).toBeCloseTo(mmToPt(210 - c.y - c.h), 3);
      expect(b.y).toBeCloseTo(pageH - mmToPt(c.x + c.w), 3);
    });
  });

  test("print mode shifts everything back by the printer's left and top hard margins", async () => {
    const hard = { top: 4, right: 3, bottom: 5, left: 3.5 };
    const s = settings({ mode: "TARGET", copies: 1, align: "TOP_LEFT" });
    const layout = layoutSheet(s, hard);
    const { bytes } = await buildPassportPdf(PHOTO_300, layout, { forPrint: true, hardMargins: hard, border: s.border });
    const { doc, pages } = await load(bytes);
    const [box] = imageBoxes(contentText(doc, pages[0]));
    const c = layout.pages[0][0];
    expect(box.x).toBeCloseTo(mmToPt(c.x - 3.5), 3);
    expect(box.y).toBeCloseTo(mmToPt(297) - mmToPt(c.y - 4 + 45), 3);
    expect(box.w).toBeCloseTo(mmToPt(35), 3);
  });
});

describe("buildPassportPdf: borders and errors", () => {
  test("cut-out borders are drawn only when turned on", async () => {
    const off = settings({ mode: "TARGET", copies: 2 });
    const on = settings({ mode: "TARGET", copies: 2, border: { enabled: true, thicknessMm: 0.3 } });
    const a = await buildPassportPdf(PHOTO_300, layoutSheet(off), { forPrint: false, border: off.border });
    const b = await buildPassportPdf(PHOTO_300, layoutSheet(on), { forPrint: false, border: on.border });
    const strokes = async (bytes: Uint8Array) => {
      const { doc, pages } = await load(bytes);
      return (contentText(doc, pages[0]).match(/(^|\s)S(\s|$)/g) ?? []).length;
    };
    expect(await strokes(a.bytes)).toBe(0);
    expect(await strokes(b.bytes)).toBe(2);
    const { doc, pages } = await load(b.bytes);
    const widths = [...contentText(doc, pages[0]).matchAll(/([-+.\d]+)\s+w(\s|$)/g)].map((m) => Number(m[1]));
    expect(widths.length).toBeGreaterThan(0);
    for (const w of widths) expect(w).toBeCloseTo(mmToPt(0.3), 3);
  });

  test("an impossible layout is refused, not shrunk", async () => {
    const s = settings({ paperSize: "4X6", photo: { widthMm: 150, heightMm: 200 } });
    await expect(buildPassportPdf(PHOTO_300, layoutSheet(s), { forPrint: false, border: s.border })).rejects.toThrow(/doesn't fit/);
  });

  test("a damaged photo gives a clear error", async () => {
    const s = settings();
    await expect(buildPassportPdf(new Uint8Array([0xff, 0xd8, 0xff, 0, 1, 2]), layoutSheet(s), { forPrint: false, border: s.border })).rejects.toThrow(
      /couldn't be added/,
    );
  });
});
