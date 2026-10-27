import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, test, vi } from "vitest";

import type { PassportSheetSettings } from "../../shared/passport/sheet";
import type { ServerPrinter } from "../../shared/types";

const mocks = vi.hoisted(() => ({
  printHtmlExact: vi.fn(),
  recordOrder: vi.fn(),
  getPrintableArea: vi.fn(),
  deviceRequest: vi.fn(),
}));

vi.mock("electron", () => ({ app: { getVersion: () => "0.0.0", getPath: () => "." }, dialog: {} }));
vi.mock("../log", () => ({ log: { warn: () => {}, info: () => {} } }));
vi.mock("../ws/ws-client", () => ({ wsEvents: new EventEmitter() }));
vi.mock("../auth/api-client", () => ({
  ApiError: class extends Error {
    status = 0;
  },
  deviceRequest: mocks.deviceRequest,
}));
vi.mock("../printing/processor", () => ({ printHtmlExact: mocks.printHtmlExact }));
vi.mock("../printing/print-ticket", () => ({ getPrintCapabilities: vi.fn(), openPrinterPreferences: vi.fn() }));
vi.mock("../scanning/scan-service", () => ({ recordOrder: mocks.recordOrder }));
vi.mock("./printable-area", () => ({ getPrintableArea: mocks.getPrintableArea, clearPrintableAreaCache: vi.fn() }));

import { update } from "../state";
import { acceptPhoto, printSheet } from "./service";

/** A 30 × 20 px JPEG claiming 413 × 531 px (35 × 45 mm at 300 dpi) in its frame header. */
const PHOTO = (() => {
  const b = Uint8Array.from(
    atob(
      "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAKBueIx4ZKCMgoy0qqC+8P//8Nzc8P//////////////////////////////////////////////////////////wAALCAAUAB4BAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/ACiiiiiiiiiiiv/Z",
    ),
    (c) => c.charCodeAt(0),
  );
  for (let i = 2; i < b.length - 9; i++) {
    if (b[i] === 0xff && b[i + 1] === 0xc0) {
      b.set([531 >> 8, 531 & 0xff, 413 >> 8, 413 & 0xff], i + 5);
      break;
    }
  }
  return b;
})();

function printer(over: Partial<ServerPrinter> = {}): ServerPrinter {
  return {
    id: "inkjet",
    deviceId: "d",
    systemName: "Epson L3250",
    displayName: "Epson",
    isEnabled: true,
    priority: 0,
    supportsColor: true,
    supportsDuplex: false,
    paperSizes: ["A4", "4X6"],
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

const SETTINGS: PassportSheetSettings = {
  paperSize: "A4",
  customPaper: null,
  orientation: "PORTRAIT",
  photo: { widthMm: 35, heightMm: 45 },
  margins: { top: 5, right: 5, bottom: 5, left: 5 },
  gapXMm: 2,
  gapYMm: 2,
  align: "CENTER",
  mode: "TARGET",
  copies: 40,
  border: { enabled: true, thicknessMm: 0.2 },
};

let refN = 0;
function ref(): string {
  refN += 1;
  return `00000000-0000-4000-8000-${String(refN).padStart(12, "0")}`;
}

function setup(printers: ServerPrinter[] = [printer()], passport = true): string {
  update({
    signedIn: true,
    printers,
    shop: { printDpi: 600 } as never,
    entitlements: { features: { passport_photo: passport } } as never,
  });
  return acceptPhoto(PHOTO, { widthMm: 35, heightMm: 45, dpi: 300 });
}

function req(photoId: string, over: Record<string, unknown> = {}) {
  return { clientRef: ref(), photoId, settings: SETTINGS, printerId: "inkjet", copies: 1, printType: "COLOR" as const, ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPrintableArea.mockResolvedValue({ paperName: "A4", hardMargins: { top: 3, right: 3, bottom: 5, left: 3 } });
  mocks.printHtmlExact.mockResolvedValue("done");
});

describe("acceptPhoto", () => {
  test("takes a JPEG of exactly the print size", () => {
    expect(setup()).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("refuses one of the wrong size or not a JPEG", () => {
    setup();
    expect(() => acceptPhoto(PHOTO, { widthMm: 35, heightMm: 45, dpi: 600 })).toThrow("should be 827 × 1063 px");
    expect(() => acceptPhoto(new Uint8Array([1, 2, 3]), { widthMm: 35, heightMm: 45, dpi: 300 })).toThrow("valid JPEG");
    expect(() => acceptPhoto("nope", { widthMm: 35, heightMm: 45, dpi: 300 })).toThrow();
  });
});

describe("printSheet", () => {
  test("prints at exact size on the printer's queue, then records one PHOTO_SHEET order", async () => {
    const photoId = setup();
    const r = req(photoId, { copies: 2 });
    const result = await printSheet(r);
    expect(result).toEqual({ outcome: "done", sheets: 4, warning: null });
    expect(mocks.printHtmlExact).toHaveBeenCalledTimes(1);
    const call = mocks.printHtmlExact.mock.calls[0][0];
    expect(call).toMatchObject({ sheets: 2, copies: 2, printType: "COLOR", dpi: 600, ticket: { dpi: 600 }, pageMm: { widthMm: 210, heightMm: 297 } });
    // The page references the approved photo, written next to it.
    expect(call.files["photo.jpg"]).toBeInstanceOf(Uint8Array);
    expect(call.html).toContain('src="photo.jpg"');
    expect(call.html).toContain("@page { size: 210mm 297mm; margin: 0; }");
    expect(mocks.recordOrder).toHaveBeenCalledWith(
      expect.objectContaining({ clientRef: r.clientRef, kind: "PHOTO_SHEET", pages: 2, copies: 2, paperSize: "A4", printerId: "inkjet" }),
    );
  });

  test("passes the operator's paper type and quality through", async () => {
    const photoId = setup();
    await printSheet(req(photoId, { ticket: { mediaType: "PhotographicGlossy", quality: "High", dpi: 1200 } }));
    expect(mocks.printHtmlExact.mock.calls[0][0].ticket).toEqual({ mediaType: "PhotographicGlossy", quality: "High", dpi: 1200 });
  });

  test("the same clientRef prints once: a retry after success returns the first result", async () => {
    const photoId = setup();
    const r = req(photoId);
    const first = await printSheet(r);
    const again = await printSheet(r);
    expect(again).toEqual(first);
    expect(mocks.printHtmlExact).toHaveBeenCalledTimes(1);
    expect(mocks.recordOrder).toHaveBeenCalledTimes(1);
  });

  test("a second press while it's printing is refused", async () => {
    const photoId = setup();
    let release: (v: string) => void = () => {};
    mocks.printHtmlExact.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    const r = req(photoId);
    const first = printSheet(r);
    await vi.waitFor(() => expect(mocks.printHtmlExact).toHaveBeenCalled());
    await expect(printSheet(r)).rejects.toThrow("already printing");
    release("done");
    await first;
    expect(mocks.printHtmlExact).toHaveBeenCalledTimes(1);
  });

  test("a failed print isn't charged and can be retried with the same clientRef", async () => {
    const photoId = setup();
    mocks.printHtmlExact.mockRejectedValueOnce(new Error("SumatraPDF exited with code 1"));
    const r = req(photoId);
    await expect(printSheet(r)).rejects.toThrow("SumatraPDF");
    expect(mocks.recordOrder).not.toHaveBeenCalled();
    await expect(printSheet(r)).resolves.toMatchObject({ outcome: "done" });
    expect(mocks.recordOrder).toHaveBeenCalledTimes(1);
  });

  test("'uncertain' is passed on, never turned into 'printed'", async () => {
    const photoId = setup();
    mocks.printHtmlExact.mockResolvedValueOnce("uncertain");
    await expect(printSheet(req(photoId))).resolves.toMatchObject({ outcome: "uncertain" });
  });

  test("refuses an unknown, turned-off, offline or erroring printer", async () => {
    const photoId = setup([printer(), printer({ id: "off", isEnabled: false }), printer({ id: "down", status: "OFFLINE" }), printer({ id: "jam", status: "ERROR" })]);
    await expect(printSheet(req(photoId, { printerId: "ghost" }))).rejects.toThrow("Choose a printer");
    await expect(printSheet(req(photoId, { printerId: "off" }))).rejects.toThrow("turned off");
    await expect(printSheet(req(photoId, { printerId: "down" }))).rejects.toThrow("offline");
    await expect(printSheet(req(photoId, { printerId: "jam" }))).rejects.toThrow("error");
    expect(mocks.printHtmlExact).not.toHaveBeenCalled();
  });

  test("refuses paper the printer isn't set up for, and colour on a mono printer", async () => {
    const photoId = setup([printer({ paperSizes: ["A4"] }), printer({ id: "mono", supportsColor: false })]);
    await expect(printSheet(req(photoId, { settings: { ...SETTINGS, paperSize: "4X6", margins: { top: 3, right: 3, bottom: 3, left: 3 } } }))).rejects.toThrow(
      "isn't set up for 4 × 6 in",
    );
    await expect(printSheet(req(photoId, { printerId: "mono" }))).rejects.toThrow("colour");
  });

  test("custom paper can be exported but not printed", async () => {
    const photoId = setup();
    await expect(printSheet(req(photoId, { settings: { ...SETTINGS, paperSize: "CUSTOM", customPaper: { widthMm: 100, heightMm: 100 } } }))).rejects.toThrow(
      "not printed",
    );
  });

  test("refuses when the plan doesn't include passport photos", async () => {
    const photoId = setup();
    update({ entitlements: { features: { passport_photo: false } } as never });
    await expect(printSheet(req(photoId))).rejects.toThrow("aren't in your plan");
  });

  test("refuses a photo that wasn't approved", async () => {
    setup();
    await expect(printSheet(req("not-approved"))).rejects.toThrow("Approve the photo again");
  });

  test("prints the sheet unshifted, the printer's margins only keeping photos clear of the edge", async () => {
    const photoId = setup();
    mocks.getPrintableArea.mockResolvedValueOnce(null);
    const result = await printSheet(req(photoId));
    expect(result.warning).toBeNull();
    expect(mocks.printHtmlExact).toHaveBeenCalledTimes(1);
  });

  test("an impossible layout is reported before anything prints", async () => {
    const photoId = setup();
    await expect(printSheet(req(photoId, { settings: { ...SETTINGS, photo: { widthMm: 250, heightMm: 300 } } }))).rejects.toThrow("doesn't fit");
    expect(mocks.printHtmlExact).not.toHaveBeenCalled();
  });
});
