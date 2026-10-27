import { describe, expect, test } from "vitest";

import { printBoxes, printPage } from "../../shared/passport/print-boxes";
import { layoutSheet, type PassportSheetSettings } from "../../shared/passport/sheet";
import { buildSheetHtml } from "./sheet-html";

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
    border: { enabled: true, thicknessMm: 0.2 },
    ...over,
  };
}

const num = (s: string) => Number(s.replace("mm", ""));

/** Every cell's left/top/width/height (mm) and its image's size and turn, read back from the HTML. */
function cells(html: string) {
  return [...html.matchAll(/<div class="cell" style="left:([\d.]+mm);top:([\d.]+mm);width:([\d.]+mm);height:([\d.]+mm)"><img[^>]*style="([^"]*)">/g)].map((m) => ({
    x: num(m[1]),
    y: num(m[2]),
    w: num(m[3]),
    h: num(m[4]),
    img: m[5],
  }));
}

describe("printBoxes (the page that's printed)", () => {
  test("a portrait sheet prints as laid out", () => {
    const layout = layoutSheet(settings());
    expect(printPage(layout)).toEqual({ widthMm: 210, heightMm: 297, turned: false });
    printBoxes(layout, 0).forEach((b, i) => expect(b).toEqual({ ...layout.pages[0][i], rotation: 0 }));
  });

  test("a landscape 4×6 sheet is turned clockwise inside a portrait page, every photo still 35 × 45 mm and on the page", () => {
    const layout = layoutSheet(settings({ paperSize: "4X6", orientation: "LANDSCAPE", margins: { top: 1, right: 1, bottom: 1, left: 1 } }, ), {
      top: 3,
      right: 3,
      bottom: 3,
      left: 3,
    });
    expect(layout.perSheet).toBe(8);
    const page = printPage(layout);
    expect(page).toEqual({ widthMm: 101.6, heightMm: 152.4, turned: true });
    const boxes = printBoxes(layout, 0);
    boxes.forEach((b, i) => {
      const c = layout.pages[0][i];
      expect([b.w, b.h, b.rotation]).toEqual([45, 35, 90]);
      expect(b.x).toBeCloseTo(101.6 - c.y - c.h, 9);
      expect(b.y).toBeCloseTo(c.x, 9);
      expect(b.x).toBeGreaterThanOrEqual(3 - 1e-9);
      expect(b.y).toBeGreaterThanOrEqual(3 - 1e-9);
      expect(b.x + b.w).toBeLessThanOrEqual(page.widthMm - 3 + 1e-9);
      expect(b.y + b.h).toBeLessThanOrEqual(page.heightMm - 3 + 1e-9);
    });
  });
});

describe("buildSheetHtml", () => {
  test("pages are exactly the paper size with no margins", () => {
    expect(buildSheetHtml(layoutSheet(settings()), "photo.jpg", settings().border)).toContain("@page { size: 210mm 297mm; margin: 0; }");
    const sixByFour = layoutSheet(settings({ paperSize: "4X6", orientation: "LANDSCAPE", margins: { top: 3, right: 3, bottom: 3, left: 3 } }));
    expect(buildSheetHtml(sixByFour, "photo.jpg", settings().border)).toContain("@page { size: 101.6mm 152.4mm; margin: 0; }");
  });

  test("every photo sits where the layout put it, at 35 × 45 mm", () => {
    const layout = layoutSheet(settings());
    const found = cells(buildSheetHtml(layout, "photo.jpg", settings().border));
    expect(found).toHaveLength(30);
    found.forEach((c, i) => {
      const want = layout.pages[0][i];
      expect(c.x).toBeCloseTo(want.x, 3);
      expect(c.y).toBeCloseTo(want.y, 3);
      expect([c.w, c.h]).toEqual([35, 45]);
      expect(c.img).toContain("width:35mm;height:45mm");
    });
  });

  test("on a turned sheet the photo keeps its own shape and is rotated, not stretched", () => {
    const layout = layoutSheet(settings({ paperSize: "4X6", orientation: "LANDSCAPE", margins: { top: 3, right: 3, bottom: 3, left: 3 } }));
    const found = cells(buildSheetHtml(layout, "photo.jpg", settings().border));
    expect(found).toHaveLength(8);
    for (const c of found) {
      expect([c.w, c.h]).toEqual([45, 35]);
      expect(c.img).toContain("width:35mm;height:45mm;transform:translate(-50%,-50%) rotate(90deg)");
    }
  });

  test("one page per sheet; the photo is referenced, not repeated inline", () => {
    const layout = layoutSheet(settings({ mode: "TARGET", copies: 65 }));
    const html = buildSheetHtml(layout, "photo.jpg", settings().border);
    expect(html.match(/<div class="page">/g)).toHaveLength(3);
    expect(cells(html)).toHaveLength(65);
    expect(html).not.toContain("data:");
  });

  test("cut-out borders only when on, at their thickness", () => {
    const layout = layoutSheet(settings({ mode: "TARGET", copies: 2 }));
    expect(buildSheetHtml(layout, "photo.jpg", { enabled: true, thicknessMm: 0.3 }).match(/class="edge" style="border-width:0.3mm"/g)).toHaveLength(2);
    expect(buildSheetHtml(layout, "photo.jpg", { enabled: false, thicknessMm: 0.3 })).not.toContain('class="edge"');
  });

  test("an impossible layout is refused", () => {
    expect(() => buildSheetHtml(layoutSheet(settings({ photo: { widthMm: 250, heightMm: 300 } })), "photo.jpg", settings().border)).toThrow(/doesn't fit/);
  });
});
