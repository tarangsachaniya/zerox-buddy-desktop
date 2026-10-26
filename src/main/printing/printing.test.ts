import { describe, expect, test } from "vitest";

import type { ServerPrinter } from "../../shared/types";
import { normaliseRanges, sumatraSettings } from "./print-settings";
import { routeJob } from "./router";

function printer(over: Partial<ServerPrinter>): ServerPrinter {
  return {
    id: "p",
    deviceId: "d",
    systemName: "P",
    displayName: "P",
    isEnabled: true,
    priority: 0,
    supportsColor: false,
    supportsDuplex: false,
    paperSizes: ["A4"],
    capabilitiesOverridden: false,
    manualDuplex: false,
    manualDuplexEvenOrder: "REVERSE",
    manualDuplexFirst: "ODD",
    manualDuplexNote: null,
    pagesPerMinute: 15,
    status: "ONLINE",
    statusMessage: null,
    lastSeenAt: null,
    ...over,
  };
}

const laser = printer({ id: "laser", displayName: "Laser", supportsDuplex: true });
const color = printer({ id: "color", displayName: "Color", supportsColor: true, paperSizes: ["A4", "A3"] });

describe("routeJob", () => {
  test("B&W A4 goes to the least busy compatible printer, then priority", () => {
    const bw = { printType: "BW" as const, paperSize: "A4" as const, duplex: false };
    const laser2 = printer({ id: "laser2", displayName: "Another Laser" });
    expect(routeJob(bw, [laser, laser2])).toMatchObject({ ok: true, printer: { id: "laser2" } }); // name order at equal priority
    expect(routeJob(bw, [{ ...laser, priority: -1 }, laser2])).toMatchObject({ ok: true, printer: { id: "laser" } });
    expect(routeJob(bw, [laser, laser2], { laser2: 2 })).toMatchObject({ ok: true, printer: { id: "laser" } });
  });

  test("B&W keeps off the color printer while a B&W-only one can take it", () => {
    const bw = { printType: "BW" as const, paperSize: "A4" as const, duplex: false };
    expect(routeJob(bw, [laser, color])).toMatchObject({ ok: true, printer: { id: "laser" } });
    expect(routeJob(bw, [laser, { ...color, priority: -5 }])).toMatchObject({ ok: true, printer: { id: "laser" } });
    expect(routeJob(bw, [laser, color], { laser: 3 })).toMatchObject({ ok: true, printer: { id: "laser" } });
    // Only the color printer fits: it still takes the job.
    expect(routeJob({ ...bw, paperSize: "A3" }, [laser, color])).toMatchObject({ ok: true, printer: { id: "color" } });
    expect(routeJob(bw, [{ ...laser, status: "OFFLINE" }, color])).toMatchObject({ ok: true, printer: { id: "color" } });
  });

  test("color and A3 only go where supported; duplex only to duplex printers", () => {
    expect(routeJob({ printType: "COLOR", paperSize: "A3", duplex: false }, [laser, color])).toMatchObject({ ok: true, printer: { id: "color" } });
    expect(routeJob({ printType: "BW", paperSize: "A4", duplex: true }, [laser, color])).toMatchObject({ ok: true, printer: { id: "laser" } });
  });

  test("manual duplex accepts duplex jobs, but a native duplex printer wins", () => {
    const manual = printer({ id: "manual", displayName: "Aaa Manual", manualDuplex: true });
    const job = { printType: "BW" as const, paperSize: "A4" as const, duplex: true };
    expect(routeJob(job, [manual])).toMatchObject({ ok: true, printer: { id: "manual" } });
    expect(routeJob(job, [manual, laser])).toMatchObject({ ok: true, printer: { id: "laser" } });
    // Single-sided jobs are not steered by it.
    expect(routeJob({ ...job, duplex: false }, [manual, laser])).toMatchObject({ ok: true, printer: { id: "manual" } });
  });

  test("explains why nothing fits", () => {
    const r1 = routeJob({ printType: "COLOR", paperSize: "A4", duplex: true }, [laser, color]);
    expect(r1).toEqual({ ok: false, reason: "No printer here can print color, A4, double-sided." });
    const r2 = routeJob({ printType: "BW", paperSize: "A4", duplex: false }, [{ ...laser, status: "OFFLINE" }]);
    expect(r2).toEqual({ ok: false, reason: "Laser is offline or needs attention." });
    const r3 = routeJob({ printType: "BW", paperSize: "A4", duplex: false }, [{ ...laser, isEnabled: false }]);
    expect(r3.ok).toBe(false);
  });

  test("a busy printer still counts as available", () => {
    const r = routeJob({ printType: "BW", paperSize: "A4", duplex: false }, [{ ...laser, status: "BUSY" }]);
    expect(r).toMatchObject({ ok: true, printer: { id: "laser" } });
  });
});

describe("sumatraSettings", () => {
  test("document with ranges, copies, duplex, color", () => {
    expect(
      sumatraSettings({
        pageRanges: "1-5, 8",
        copies: 2,
        duplex: true,
        printType: "COLOR",
        paperSize: "A3",
        orientation: "PORTRAIT",
        isImage: false,
      }),
    ).toBe("1-5,8,2x,duplexlong,color,paper=A3,portrait,fit");
  });

  test("defaults: all pages, one copy, simplex, monochrome, A4, portrait", () => {
    expect(
      sumatraSettings({ pageRanges: null, copies: 1, duplex: false, printType: "BW", paperSize: null, orientation: "PORTRAIT", isImage: false }),
    ).toBe("1x,simplex,monochrome,paper=A4,portrait,fit");
  });

  test("images ignore ranges; copies are clamped", () => {
    expect(
      sumatraSettings({ pageRanges: "1-3", copies: 500, duplex: false, printType: "BW", paperSize: "A4", orientation: "PORTRAIT", isImage: true }),
    ).toBe("99x,simplex,monochrome,paper=A4,portrait,fit");
  });

  test("landscape orientation is passed through to Sumatra", () => {
    expect(
      sumatraSettings({ pageRanges: null, copies: 1, duplex: false, printType: "BW", paperSize: "A4", orientation: "LANDSCAPE", isImage: false }),
    ).toBe("1x,simplex,monochrome,paper=A4,landscape,fit");
  });

  test("pre-laid-out sheets print as-is on portrait paper, even for a landscape job", () => {
    expect(
      sumatraSettings({ pageRanges: "1-3", copies: 1, duplex: true, duplexFlip: "SHORT", printType: "BW", paperSize: "A4", orientation: "LANDSCAPE", isImage: false, prelaid: true }),
    ).toBe("1x,duplexshort,monochrome,paper=A4,portrait,fit");
    expect(
      sumatraSettings({ pageRanges: null, copies: 1, duplex: false, printType: "BW", paperSize: "A4", orientation: "AUTO", isImage: false, prelaid: true }),
    ).toBe("1x,simplex,monochrome,paper=A4,portrait,fit");
  });

  test("refuses anything that isn't a page selection", () => {
    expect(() => normaliseRanges("1-3; del C:\\")).toThrow();
    expect(normaliseRanges("  ")).toBeNull();
  });
});
