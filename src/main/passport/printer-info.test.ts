import { describe, expect, test, vi } from "vitest";

vi.mock("../log", () => ({ log: { warn: () => {}, info: () => {} } }));

import { sumatraKnowsPaper, sumatraSettings } from "../printing/print-settings";
import { isEmptyTicket, mediaLabel, paperMatches, pickResolution, toCapabilities } from "../printing/print-ticket";
import { toPrintableArea } from "./printable-area";

describe("toPrintableArea", () => {
  test("turns .NET's hundredths of an inch into portrait hard margins in mm", () => {
    // A4 is 827 × 1169; a printable area inset 17/17 left/top, 16/18 right/bottom.
    const area = toPrintableArea({ found: true, name: "A4", w: 827, h: 1169, x: 17, y: 17, aw: 794, ah: 1134 });
    expect(area).toEqual({ paperName: "A4", hardMargins: { left: 4.32, top: 4.32, right: 4.06, bottom: 4.57 } });
  });

  test("a borderless printer has no hard margins", () => {
    expect(toPrintableArea({ found: true, name: "4x6", w: 400, h: 600, x: 0, y: 0, aw: 400, ah: 600 })?.hardMargins).toEqual({
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
    });
  });

  test("a paper reported landscape is turned back to portrait", () => {
    const area = toPrintableArea({ found: true, name: "4x6", w: 600, h: 400, x: 10, y: 20, aw: 570, ah: 370 });
    expect(area?.hardMargins).toEqual({ left: 5.08, top: 2.54, right: 2.54, bottom: 5.08 });
  });

  test("no paper, nonsense, or missing numbers mean 'unknown'", () => {
    expect(toPrintableArea({ found: false })).toBeNull();
    expect(toPrintableArea({ found: true, w: 827, h: 1169, x: 300, y: 0, aw: 100, ah: 1169 })).toBeNull();
    expect(toPrintableArea({ found: true, w: 827, h: 1169 })).toBeNull();
  });
});

describe("print options", () => {
  test("lists what the driver offers, without the non-choices, smallest DPI first", () => {
    const caps = toCapabilities({
      ok: true,
      media: ["Plain", "PhotographicGlossy", "Unknown", "Plain", "Bad Name!"],
      quality: ["Draft", "Normal", "High"],
      res: [
        { x: 600, y: 600 },
        { x: 300, y: 300 },
        { x: 600, y: 600 },
        { x: 0, y: 0 },
      ],
      current: { media: "Plain", quality: "Unknown", x: 600, y: 600 },
    });
    expect(caps).toEqual({
      mediaTypes: [
        { value: "Plain", label: "Plain paper" },
        { value: "PhotographicGlossy", label: "Photo paper (glossy)" },
      ],
      qualities: [
        { value: "Draft", label: "Draft" },
        { value: "Normal", label: "Normal" },
        { value: "High", label: "High" },
      ],
      resolutions: [
        { x: 300, y: 300 },
        { x: 600, y: 600 },
      ],
      current: { mediaType: "Plain", quality: null, dpi: 600 },
    });
  });

  test("a single value from PowerShell (not an array) still works", () => {
    const caps = toCapabilities({ ok: true, media: "Plain", quality: null, res: { x: 300, y: 300 } });
    expect(caps?.mediaTypes).toEqual([{ value: "Plain", label: "Plain paper" }]);
    expect(caps?.resolutions).toEqual([{ x: 300, y: 300 }]);
    expect(toCapabilities({ ok: false, error: "Printer not found" })).toBeNull();
  });

  test("labels unknown media readably", () => {
    expect(mediaLabel("SemiGlossyCardStock")).toBe("Semi Glossy Card Stock");
  });

  test("picks the asked DPI, else the best below it, else the lowest; 0 is the maximum", () => {
    const offered = [
      { x: 300, y: 300 },
      { x: 600, y: 600 },
      { x: 1200, y: 600 },
      { x: 1200, y: 1200 },
    ];
    expect(pickResolution(offered, 600)).toEqual({ x: 600, y: 600 });
    expect(pickResolution(offered, 1200)).toEqual({ x: 1200, y: 1200 });
    expect(pickResolution(offered, 800)).toEqual({ x: 600, y: 600 });
    expect(pickResolution(offered, 150)).toEqual({ x: 300, y: 300 });
    expect(pickResolution(offered, 0)).toEqual({ x: 1200, y: 1200 });
    expect(pickResolution([], 600)).toBeNull();
  });

  test("a paper on the ticket counts as a change", () => {
    expect(isEmptyTicket({ paper: { widthMm: 101.6, heightMm: 152.4 } })).toBe(false);
  });

  test("an empty ticket changes nothing", () => {
    expect(isEmptyTicket(null)).toBe(true);
    expect(isEmptyTicket({})).toBe(true);
    expect(isEmptyTicket({ dpi: null, mediaType: null })).toBe(true);
    expect(isEmptyTicket({ dpi: 0 })).toBe(false);
    expect(isEmptyTicket({ mediaType: "PhotographicGlossy" })).toBe(false);
  });
});

describe("4 × 6 in paper", () => {
  const SIX = { widthMm: 101.6, heightMm: 152.4 };
  const px = (mm: number) => (mm / 25.4) * 96;

  test("the paper Windows reports back must be the one asked for, either way round", () => {
    expect(paperMatches(SIX, { w: px(101.6), h: px(152.4) })).toBe(true);
    expect(paperMatches(SIX, { w: px(152.4), h: px(101.6) })).toBe(true);
    expect(paperMatches(SIX, { w: px(210), h: px(297) })).toBe(false); // still A4: the bug behind the printer's paper error
    expect(paperMatches(SIX, {})).toBe(false);
  });

  test("SumatraPDF can't name 4×6, so a passport print leaves the paper to the printer's ticket", () => {
    expect(sumatraKnowsPaper("4X6")).toBe(false);
    expect(sumatraKnowsPaper("A4")).toBe(true);
    const base = { pageRanges: null, copies: 1, duplex: false, printType: "COLOR" as const, orientation: "PORTRAIT" as const, isImage: false, prelaid: true, exact: true };
    expect(sumatraSettings({ ...base, paperSize: "4X6" })).toBe("1x,simplex,color,portrait,noscale");
    expect(sumatraSettings({ ...base, paperSize: "A4" })).toBe("1x,simplex,color,paper=A4,portrait,noscale");
  });
});

describe("the driver's own paper types (HP, Epson, Canon)", () => {
  test("are offered by their Preferences names when Windows' standard list is empty", () => {
    const caps = toCapabilities({
      ok: true,
      media: [],
      dmMedia: [
        { id: 257, name: "Plain paper" },
        { id: 261, name: "HP Advanced Photo Paper, glossy" },
        { id: 262, name: "Brochure paper, matte " },
        { id: 261, name: "HP Advanced Photo Paper, glossy" },
        { id: 0, name: "broken" },
      ],
      dmCurrent: 257,
      quality: ["Draft", "Normal", "High"],
      res: [],
      current: { media: "Unknown", quality: "Normal", x: 300, y: 300 },
    });
    expect(caps?.mediaTypes).toEqual([
      { value: "dm:257", label: "Plain paper" },
      { value: "dm:261", label: "HP Advanced Photo Paper, glossy" },
      { value: "dm:262", label: "Brochure paper, matte" },
    ]);
    expect(caps?.current?.mediaType).toBe("dm:257");
  });

  test("standard names win when the driver gives them", () => {
    const caps = toCapabilities({ ok: true, media: ["Plain", "PhotographicGlossy"], dmMedia: [{ id: 257, name: "Plain paper" }], quality: [], res: [] });
    expect(caps?.mediaTypes.map((m) => m.value)).toEqual(["Plain", "PhotographicGlossy"]);
  });
});
