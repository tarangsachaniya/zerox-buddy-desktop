import { describe, expect, test } from "vitest";

import { inspectPhoto, jpegDimensions, MAX_PHOTO_BYTES, PhotoError, sniffKind } from "./photo-file";

/** A 30 × 20 px JPEG (from compose.test.ts). */
const JPEG = Uint8Array.from(
  atob(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAKBueIx4ZKCMgoy0qqC+8P//8Nzc8P//////////////////////////////////////////////////////////wAALCAAUAB4BAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/ACiiiiiiiiiiiv/Z",
  ),
  (c) => c.charCodeAt(0),
);

/** A 1 × 1 transparent PNG. */
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) =>
  c.charCodeAt(0),
);

function pngClaiming(width: number, height: number): Uint8Array {
  const b = PNG.slice();
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

describe("inspectPhoto", () => {
  test("reads a JPEG's size from its bytes", () => {
    expect(inspectPhoto(JPEG)).toEqual({ kind: "jpeg", mime: "image/jpeg", width: 30, height: 20 });
  });

  test("reads a PNG's size from its bytes", () => {
    expect(inspectPhoto(PNG)).toEqual({ kind: "png", mime: "image/png", width: 1, height: 1 });
  });

  test("goes by the bytes, not the name: anything else is refused", () => {
    expect(() => inspectPhoto(new TextEncoder().encode("%PDF-1.7 not a photo"))).toThrow("isn't a JPEG or PNG");
    expect(() => inspectPhoto(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toThrow("isn't a JPEG or PNG"); // GIF
    expect(sniffKind(Uint8Array.from([0x42, 0x4d]))).toBeNull(); // BMP
  });

  test("an empty file is refused", () => {
    expect(() => inspectPhoto(new Uint8Array())).toThrow("empty");
  });

  test("a truncated PNG is refused", () => {
    expect(() => inspectPhoto(PNG.subarray(0, 40))).toThrow("damaged or incomplete");
    expect(() => inspectPhoto(PNG.subarray(0, 12))).toThrow("damaged or incomplete");
  });

  test("a JPEG cut off before its frame header is refused", () => {
    expect(() => inspectPhoto(JPEG.subarray(0, 30))).toThrow("damaged or incomplete");
    expect(() => inspectPhoto(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]))).toThrow("damaged or incomplete");
  });

  test("an absurdly large photo is refused before it's decoded", () => {
    expect(() => inspectPhoto(pngClaiming(30_000, 100))).toThrow(PhotoError);
    expect(() => inspectPhoto(pngClaiming(12_000, 12_000))).toThrow("too large");
    expect(() => inspectPhoto(new Uint8Array(MAX_PHOTO_BYTES + 1).fill(0xff))).toThrow("over 40 MB");
  });

  test("a zero-size image is refused", () => {
    expect(() => inspectPhoto(pngClaiming(0, 10))).toThrow("damaged or incomplete");
  });
});

describe("jpegDimensions", () => {
  test("only answers for JPEGs", () => {
    expect(jpegDimensions(JPEG)).toEqual({ width: 30, height: 20 });
    expect(jpegDimensions(PNG)).toBeNull();
  });
});
