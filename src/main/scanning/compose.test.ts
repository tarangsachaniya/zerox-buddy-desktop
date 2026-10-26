import { PDFDocument } from "pdf-lib";
import { describe, expect, test } from "vitest";

import { composePdf } from "./compose";
import type { ComposePage, Rotation } from "./compose";

/** A 30 × 20 px grey JPEG: landscape-shaped, so rotation shows in the layout. */
const JPEG = Uint8Array.from(
  atob(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAKBueIx4ZKCMgoy0qqC+8P//8Nzc8P//////////////////////////////////////////////////////////wAALCAAUAB4BAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/ACiiiiiiiiiiiv/Z",
  ),
  (c) => c.charCodeAt(0),
);

const page = (rotation: Rotation = 0): ComposePage => ({ jpeg: JPEG, rotation, dpi: 10 });

async function sizes(bytes: Uint8Array): Promise<[number, number][]> {
  return (await PDFDocument.load(bytes)).getPages().map((p) => {
    const { width, height } = p.getSize();
    return [Math.round(width), Math.round(height)];
  });
}

const A4: [number, number] = [595, 842];

describe("composePdf", () => {
  test("one sheet per scan; a sideways scan gets a landscape sheet, a turned one portrait", async () => {
    const r = await composePdf([page(0), page(90), page(180)], { paperSize: "A4", idCard: false });
    expect(r.sheets).toBe(3);
    expect(await sizes(r.bytes)).toEqual([[842, 595], A4, [842, 595]]);
  });

  test("ID card: front and back share one A4 sheet; an odd card gets its own", async () => {
    const r = await composePdf([page(), page(), page()], { paperSize: "A4", idCard: true });
    expect(r.sheets).toBe(2);
    expect(await sizes(r.bytes)).toEqual([A4, A4]);
  });

  test("A3 sheets for A3", async () => {
    const r = await composePdf([page(90)], { paperSize: "A3", idCard: false });
    expect(await sizes(r.bytes)).toEqual([[842, 1191]]);
  });

  test("nothing scanned is an error, not an empty PDF", async () => {
    await expect(composePdf([], { paperSize: "A4", idCard: false })).rejects.toThrow("Scan at least one page first");
  });
});
