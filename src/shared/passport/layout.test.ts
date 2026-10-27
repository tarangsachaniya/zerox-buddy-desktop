import { describe, expect, it } from "vitest";

import { computeSheetLayout, fitCount, orientHardMargins, type SheetSpec } from "./layout";
import { resolvePaper } from "./paper";

const m = (n: number) => ({ top: n, right: n, bottom: n, left: n });

function spec(over: Partial<SheetSpec> = {}): SheetSpec {
  return {
    paper: resolvePaper("A4", "PORTRAIT"),
    photo: { widthMm: 35, heightMm: 45 },
    margins: m(5),
    gapXMm: 2,
    gapYMm: 2,
    align: "CENTER",
    mode: "AUTO_FIT",
    copies: 1,
    border: { enabled: false, thicknessMm: 0.2 },
    ...over,
  };
}

function inside(layout: ReturnType<typeof computeSheetLayout>) {
  const p = layout.printable;
  for (const page of layout.pages) {
    for (const c of page) {
      expect(c.x).toBeGreaterThanOrEqual(p.x - 1e-9);
      expect(c.y).toBeGreaterThanOrEqual(p.y - 1e-9);
      expect(c.x + c.w).toBeLessThanOrEqual(p.x + p.w + 1e-9);
      expect(c.y + c.h).toBeLessThanOrEqual(p.y + p.h + 1e-9);
    }
  }
}

function noOverlap(cells: { x: number; y: number; w: number; h: number }[]) {
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      const a = cells[i];
      const b = cells[j];
      const overlap = a.x < b.x + b.w - 1e-9 && b.x < a.x + a.w - 1e-9 && a.y < b.y + b.h - 1e-9 && b.y < a.y + a.h - 1e-9;
      expect(overlap).toBe(false);
    }
  }
}

describe("resolvePaper", () => {
  it("knows A4 and 4×6 in both orientations", () => {
    expect(resolvePaper("A4", "PORTRAIT")).toEqual({ widthMm: 210, heightMm: 297 });
    expect(resolvePaper("A4", "LANDSCAPE")).toEqual({ widthMm: 297, heightMm: 210 });
    expect(resolvePaper("4X6", "PORTRAIT")).toEqual({ widthMm: 101.6, heightMm: 152.4 });
    expect(resolvePaper("4X6", "LANDSCAPE")).toEqual({ widthMm: 152.4, heightMm: 101.6 });
  });

  it("takes a custom size and refuses a bad one", () => {
    expect(resolvePaper("CUSTOM", "PORTRAIT", { widthMm: 150, heightMm: 100 })).toEqual({ widthMm: 100, heightMm: 150 });
    expect(() => resolvePaper("CUSTOM", "PORTRAIT", { widthMm: 0, heightMm: 100 })).toThrow();
    expect(() => resolvePaper("CUSTOM", "PORTRAIT", { widthMm: -5, heightMm: 100 })).toThrow();
    expect(() => resolvePaper("CUSTOM", "PORTRAIT", null)).toThrow();
    expect(() => resolvePaper("LETTER" as never, "PORTRAIT")).toThrow(/Unsupported/);
  });
});

describe("fitCount", () => {
  it("counts items with gaps between them, not after the last", () => {
    expect(fitCount(200, 35, 2)).toBe(5); // 5×35 + 4×2 = 183
    expect(fitCount(184, 36, 1)).toBe(5); // 5×36 + 4×1 = 184 exactly
    expect(fitCount(34, 35, 2)).toBe(0);
    expect(fitCount(35, 35, 2)).toBe(1);
  });
});

describe("computeSheetLayout", () => {
  it("fits 30 passport photos on A4 portrait with 5 mm margins and 2 mm gaps", () => {
    const l = computeSheetLayout(spec());
    expect(l.errors).toEqual([]);
    expect(l.printable).toEqual({ x: 5, y: 5, w: 200, h: 287 });
    expect([l.cols, l.rows, l.perSheet, l.sheets]).toEqual([5, 6, 30, 1]);
    expect(l.pages[0]).toHaveLength(30);
    inside(l);
    noOverlap(l.pages[0]);
  });

  it("keeps every photo at its exact physical size", () => {
    const l = computeSheetLayout(spec());
    for (const c of l.pages[0]) expect([c.w, c.h]).toEqual([35, 45]);
  });

  it("lays out A4 landscape", () => {
    const l = computeSheetLayout(spec({ paper: resolvePaper("A4", "LANDSCAPE") }));
    // 287 wide → 7 columns (7×35+6×2 = 257); 200 tall → 4 rows (4×45+3×2 = 186)
    expect([l.cols, l.rows, l.perSheet]).toEqual([7, 4, 28]);
    inside(l);
  });

  it("lays out 4×6 portrait and landscape", () => {
    const p = computeSheetLayout(spec({ paper: resolvePaper("4X6", "PORTRAIT"), margins: m(3) }));
    // 95.6 wide → 2 columns; 146.4 tall → 3 rows
    expect([p.cols, p.rows, p.perSheet]).toEqual([2, 3, 6]);
    inside(p);
    const l = computeSheetLayout(spec({ paper: resolvePaper("4X6", "LANDSCAPE"), margins: m(3) }));
    // 146.4 wide → 4 columns (4×35+3×2 = 146); 95.6 tall → 2 rows
    expect([l.cols, l.rows, l.perSheet]).toEqual([4, 2, 8]);
    inside(l);
  });

  it("centres the grid when asked, or pins it to the top-left margin", () => {
    const c = computeSheetLayout(spec());
    const gridW = 5 * 35 + 4 * 2;
    const gridH = 6 * 45 + 5 * 2;
    expect(c.pages[0][0].x).toBeCloseTo(5 + (200 - gridW) / 2);
    expect(c.pages[0][0].y).toBeCloseTo(5 + (287 - gridH) / 2);
    const t = computeSheetLayout(spec({ align: "TOP_LEFT" }));
    expect(t.pages[0][0]).toMatchObject({ x: 5, y: 5 });
    expect(t.pages[0][1].x).toBeCloseTo(5 + 35 + 2);
    expect(t.pages[0][5].y).toBeCloseTo(5 + 45 + 2);
  });

  it("honours different margins on each side and the gaps", () => {
    const l = computeSheetLayout(spec({ margins: { top: 20, right: 10, bottom: 30, left: 15 }, gapXMm: 5, gapYMm: 8, align: "TOP_LEFT" }));
    expect(l.printable).toEqual({ x: 15, y: 20, w: 185, h: 247 });
    expect(l.cols).toBe(4); // 4×35+3×5 = 155; 5×35+4×5 = 195 > 185
    expect(l.rows).toBe(4); // 4×45+3×8 = 204; 5×45+4×8 = 257 > 247
    expect(l.pages[0][1].x - l.pages[0][0].x).toBeCloseTo(40);
    expect(l.pages[0][4].y - l.pages[0][0].y).toBeCloseTo(53);
    inside(l);
  });

  it("centres on the paper even when the margins differ, staying inside the printable area", () => {
    // Uneven margins (e.g. a printer with a big bottom margin): the grid is still centred on the sheet.
    // 6 rows need 280 mm; 297 − 5 − 8 leaves 284, so there's room to centre.
    const l = computeSheetLayout(spec({ margins: { top: 5, right: 5, bottom: 8, left: 5 } }));
    const first = l.pages[0][0];
    const last = l.pages[0][l.pages[0].length - 1];
    expect(first.x).toBeCloseTo(210 - (last.x + last.w), 6);
    expect(first.y).toBeCloseTo(297 - (last.y + last.h), 6);
    inside(l);
    // 297 − 5 − 10 leaves 282: centred would start at 8.5 and end 1.5 mm into the bottom margin,
    // so the grid is pushed just inside it instead.
    const tight = computeSheetLayout(spec({ margins: { top: 5, right: 5, bottom: 10, left: 5 } }));
    expect(tight.pages[0][0].y).toBeCloseTo(7, 6);
    expect(tight.pages[0][tight.pages[0].length - 1].y + 45).toBeCloseTo(297 - 10, 6);
    inside(tight);
  });

  it("raises margins to the printer's hard margins", () => {
    const l = computeSheetLayout(spec({ margins: m(1), hardMargins: { top: 4, right: 3, bottom: 6, left: 3 } }));
    expect(l.margins).toEqual({ top: 4, right: 3, bottom: 6, left: 3 });
    expect(l.printable).toEqual({ x: 3, y: 4, w: 204, h: 287 });
  });

  it("puts the requested number on one sheet when it fits", () => {
    const l = computeSheetLayout(spec({ mode: "TARGET", copies: 8 }));
    expect([l.requested, l.sheets, l.fitsOnOneSheet]).toEqual([8, 1, true]);
    expect(l.pages[0]).toHaveLength(8);
  });

  it("spills a large quantity onto more sheets, the remainder on the last", () => {
    const l = computeSheetLayout(spec({ mode: "TARGET", copies: 70 }));
    expect([l.perSheet, l.sheets, l.fitsOnOneSheet]).toEqual([30, 3, false]);
    expect(l.pages.map((p) => p.length)).toEqual([30, 30, 10]);
    for (const c of l.pages[2]) expect([c.w, c.h]).toEqual([35, 45]);
  });

  it("refuses zero or negative sizes", () => {
    expect(computeSheetLayout(spec({ photo: { widthMm: 0, heightMm: 45 } })).errors[0]).toMatch(/Photo width/);
    expect(computeSheetLayout(spec({ photo: { widthMm: 35, heightMm: -1 } })).errors[0]).toMatch(/Photo width/);
    expect(computeSheetLayout(spec({ margins: { ...m(5), left: -2 } })).errors[0]).toMatch(/negative/);
    expect(computeSheetLayout(spec({ gapXMm: -1 })).errors[0]).toMatch(/Spacing/);
    expect(computeSheetLayout(spec({ mode: "TARGET", copies: 0 })).errors[0]).toMatch(/copies/);
    expect(computeSheetLayout(spec({ mode: "TARGET", copies: 2.5 })).errors[0]).toMatch(/copies/);
    expect(computeSheetLayout(spec({ border: { enabled: true, thicknessMm: 0 } })).errors[0]).toMatch(/Border/);
  });

  it("reports an impossible layout instead of shrinking the photo", () => {
    const big = computeSheetLayout(spec({ paper: resolvePaper("4X6", "PORTRAIT"), photo: { widthMm: 120, heightMm: 160 } }));
    expect(big.errors[0]).toMatch(/doesn't fit/);
    expect(big.pages).toEqual([]);
    const margins = computeSheetLayout(spec({ margins: m(110) }));
    expect(margins.errors[0]).toMatch(/no room/);
  });

  it("caps the number of sheets", () => {
    const l = computeSheetLayout(spec({ mode: "TARGET", copies: 500, photo: { widthMm: 150, heightMm: 200 } }));
    expect(l.errors[0]).toMatch(/sheets/);
  });

  it("fits more photos than the edge allows only when they really fit", () => {
    // 4 columns of 50 mm with 0 gap need exactly 200 mm.
    const l = computeSheetLayout(spec({ photo: { widthMm: 50, heightMm: 50 }, gapXMm: 0, gapYMm: 0 }));
    expect(l.cols).toBe(4);
    inside(l);
  });
});

describe("orientHardMargins", () => {
  it("turns portrait hard margins for a landscape sheet", () => {
    const portrait = { top: 1, right: 2, bottom: 3, left: 4 };
    expect(orientHardMargins(portrait, false)).toEqual(portrait);
    expect(orientHardMargins(portrait, true)).toEqual({ left: 1, top: 2, right: 3, bottom: 4 });
  });
});

describe("framed photos (a white gap inside the cut line, like the shop's Word layouts)", () => {
  const framed = { enabled: true, thicknessMm: 0.35, paddingMm: 0.5 };

  it("4 × 6 like 'Passport Photo Layout.docx': 8 frames of 36 × 46 mm, within an HP's 3 mm margins", () => {
    const l = computeSheetLayout(
      spec({
        paper: resolvePaper("4X6", "LANDSCAPE"),
        margins: m(2),
        gapXMm: 0.75,
        gapYMm: 1.5,
        border: framed,
        hardMargins: m(3),
      }),
    );
    expect(l.errors).toEqual([]);
    expect([l.cols, l.rows, l.perSheet, l.insetMm]).toEqual([4, 2, 8, 0.5]);
    for (const c of l.pages[0]) expect([c.w, c.h]).toEqual([36, 46]);
    inside(l);
  });

  it("A4 like 'Passport_Photo_Sheet_A4.docx': 30 frames, its own margins and gaps", () => {
    const l = computeSheetLayout(
      spec({ margins: { top: 6, right: 9, bottom: 4, left: 9 }, gapXMm: 3, gapYMm: 1.5, border: framed, hardMargins: m(3) }),
    );
    expect([l.cols, l.rows, l.perSheet]).toEqual([5, 6, 30]);
    inside(l);
  });

  it("the frame counts when fitting: a gap that's too wide drops a column instead of shrinking anything", () => {
    const l = computeSheetLayout(spec({ paper: resolvePaper("4X6", "LANDSCAPE"), margins: m(3), gapXMm: 1.5, gapYMm: 1.5, border: framed }));
    expect(l.cols).toBe(3); // 4 × 36 + 3 × 1.5 = 148.5 > 146.4
  });

  it("no gap without a border, and a bad gap is refused", () => {
    expect(computeSheetLayout(spec({ border: { enabled: false, thicknessMm: 0.2, paddingMm: 2 } })).insetMm).toBe(0);
    expect(computeSheetLayout(spec({ border: { enabled: true, thicknessMm: 0.2, paddingMm: -1 } })).errors[0]).toMatch(/gap inside the border/);
  });
});
