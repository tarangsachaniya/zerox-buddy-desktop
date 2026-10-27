/**
 * Passport sheets are laid out in millimetres; these convert at the very end,
 * for the PDF (points) or the photo bitmap (pixels at the print DPI).
 */

export const MM_PER_INCH = 25.4;
export const PT_PER_INCH = 72;

export function mmToPt(mm: number): number {
  return (mm * PT_PER_INCH) / MM_PER_INCH;
}

export function ptToMm(pt: number): number {
  return (pt * MM_PER_INCH) / PT_PER_INCH;
}

export function mmToPx(mm: number, dpi: number): number {
  return Math.round((mm * dpi) / MM_PER_INCH);
}
