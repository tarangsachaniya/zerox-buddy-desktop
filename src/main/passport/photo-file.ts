/**
 * Checks a customer photo before anything else touches it: it must really be
 * a JPEG or PNG (by its bytes, not its file name), complete enough to read
 * its size, and not absurdly large. Pure, so every case is unit tested; the
 * image itself is decoded by Chromium in the renderer, never sent anywhere.
 */

export type PhotoKind = "jpeg" | "png";

export type PhotoInfo = { kind: PhotoKind; mime: string; width: number; height: number };

export const MAX_PHOTO_BYTES = 40 * 1024 * 1024;
/** 100 megapixels: far beyond any camera a customer brings, small enough to decode safely. */
export const MAX_PHOTO_PIXELS = 100_000_000;
export const MAX_PHOTO_SIDE = 20_000;
export const PHOTO_EXTENSIONS = ["jpg", "jpeg", "png"];

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export class PhotoError extends Error {}

export function sniffKind(bytes: Uint8Array): PhotoKind | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return "png";
  return null;
}

function u16be(b: Uint8Array, i: number): number {
  return (b[i] << 8) | b[i + 1];
}

function u32be(b: Uint8Array, i: number): number {
  return ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
}

/** Width and height from the PNG header; null if it's cut short or malformed. */
function pngSize(b: Uint8Array): { width: number; height: number } | null {
  // Signature (8) + IHDR length (4) + "IHDR" (4) + width (4) + height (4)
  if (b.length < 33) return null;
  if (String.fromCharCode(b[12], b[13], b[14], b[15]) !== "IHDR") return null;
  // A complete PNG ends with an IEND chunk.
  const tail = String.fromCharCode(...b.subarray(Math.max(0, b.length - 8), b.length - 4));
  if (tail !== "IEND") return null;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

/** Width and height from the JPEG's frame header; null if none is found. */
function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    // Markers without a length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end, or image data before any frame header
    const len = u16be(b, i + 2);
    if (len < 2) return null;
    // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 9 > b.length) return null;
      return { height: u16be(b, i + 5), width: u16be(b, i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

/** Throws a PhotoError the operator can act on, or returns what the photo is. */
export function inspectPhoto(bytes: Uint8Array): PhotoInfo {
  if (bytes.length === 0) throw new PhotoError("That file is empty");
  if (bytes.length > MAX_PHOTO_BYTES) throw new PhotoError(`That photo is over ${MAX_PHOTO_BYTES / 1024 / 1024} MB. Use a smaller copy`);
  const kind = sniffKind(bytes);
  if (!kind) throw new PhotoError("That isn't a JPEG or PNG photo");
  const size = kind === "png" ? pngSize(bytes) : jpegSize(bytes);
  if (!size || size.width < 1 || size.height < 1) throw new PhotoError("That photo is damaged or incomplete and can't be opened");
  if (size.width > MAX_PHOTO_SIDE || size.height > MAX_PHOTO_SIDE || size.width * size.height > MAX_PHOTO_PIXELS) {
    throw new PhotoError(`That photo is too large (${size.width} × ${size.height} px). Use one under ${MAX_PHOTO_PIXELS / 1_000_000} megapixels`);
  }
  return { kind, mime: kind === "png" ? "image/png" : "image/jpeg", ...size };
}

/** Size of a JPEG the renderer made, for checking it against what was asked. */
export function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  return sniffKind(bytes) === "jpeg" ? jpegSize(bytes) : null;
}
