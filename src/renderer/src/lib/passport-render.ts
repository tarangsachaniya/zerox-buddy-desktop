import { renderTransform, type PhotoCrop, type Size } from "../../../shared/passport/crop";

/**
 * Photo decoding and the approved-photo render for Passport Photo Studio, all
 * in this window: the photo never leaves the computer. Geometry comes from
 * shared/passport/crop.ts (tested); this file only drives the canvas.
 */

/** Longest side kept for editing. A 600 dpi passport photo needs ~1100 px; this leaves room to crop. */
export const MAX_EDIT_SIDE = 6000;

export type EditablePhoto = { bitmap: ImageBitmap; size: Size };

/**
 * Decodes the original photo. Goes through an <img> (the page's CSP allows
 * data: images, not data: fetches), which also applies a phone's EXIF
 * rotation, so the photo appears the right way up.
 */
export async function decodePhoto(dataUrl: string): Promise<EditablePhoto> {
  const img = new Image();
  img.decoding = "async";
  img.src = dataUrl;
  try {
    await img.decode();
  } catch {
    throw new Error("That photo couldn't be opened. It may be damaged");
  }
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) throw new Error("That photo couldn't be opened. It may be damaged");
  const scale = Math.min(1, MAX_EDIT_SIDE / Math.max(w, h));
  const bitmap =
    scale < 1
      ? await createImageBitmap(img, { resizeWidth: Math.round(w * scale), resizeHeight: Math.round(h * scale), resizeQuality: "high" })
      : await createImageBitmap(img);
  return { bitmap, size: { width: bitmap.width, height: bitmap.height } };
}

/**
 * Draws the crop window of the photo into `canvas` at `out` pixels. A big
 * reduction first goes through a high-quality resize of the whole photo, so
 * the final draw never shrinks by more than about a third (no aliasing).
 */
export async function drawCrop(canvas: HTMLCanvasElement, photo: EditablePhoto, crop: PhotoCrop, out: Size): Promise<void> {
  canvas.width = out.width;
  canvas.height = out.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Couldn't draw the photo");
  const k = out.width / crop.w;
  let source: ImageBitmap = photo.bitmap;
  let owned = false;
  if (k < 0.6) {
    const s = Math.min(1, k * 1.5);
    source = await createImageBitmap(photo.bitmap, {
      resizeWidth: Math.max(1, Math.round(photo.size.width * s)),
      resizeHeight: Math.max(1, Math.round(photo.size.height * s)),
      resizeQuality: "high",
    });
    owned = true;
  }
  try {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // A PNG with transparency gets a white background, as it would on paper.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.setTransform(...renderTransform(crop, out));
    // In unturned source pixels, centred on the photo, whatever the bitmap's own size.
    ctx.drawImage(source, -photo.size.width / 2, -photo.size.height / 2, photo.size.width, photo.size.height);
  } finally {
    if (owned) source.close();
  }
}

/** The approved photo as JPEG bytes at print size, plus a small preview for the sheet. */
export async function renderApproved(photo: EditablePhoto, crop: PhotoCrop, out: Size): Promise<{ jpeg: Uint8Array; previewUrl: string }> {
  const canvas = document.createElement("canvas");
  await drawCrop(canvas, photo, crop, out);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.95));
  if (!blob) throw new Error("Couldn't prepare the photo");
  const jpeg = new Uint8Array(await blob.arrayBuffer());
  const preview = document.createElement("canvas");
  const pw = Math.min(240, out.width);
  await drawCrop(preview, photo, crop, { width: pw, height: Math.max(1, Math.round((pw * out.height) / out.width)) });
  return { jpeg, previewUrl: preview.toDataURL("image/jpeg", 0.85) };
}
