/**
 * Paper for passport sheets. A4 and 4×6 in are built in; anything else is a
 * custom size in millimetres (exported as a PDF, but not printable, since
 * no printer is set up for it).
 */

export type PassportPaperCode = "A4" | "4X6" | "CUSTOM";
export type SheetOrientation = "PORTRAIT" | "LANDSCAPE";

export type PaperMm = { widthMm: number; heightMm: number };

/** Portrait dimensions. */
export const PASSPORT_PAPER: Record<Exclude<PassportPaperCode, "CUSTOM">, PaperMm & { label: string }> = {
  A4: { widthMm: 210, heightMm: 297, label: "A4" },
  "4X6": { widthMm: 101.6, heightMm: 152.4, label: "4 × 6 in" },
};

export const MAX_PAPER_MM = 1200;

/**
 * The sheet as laid out: portrait has the short side across, landscape the
 * long side. Throws for an unknown code or a bad custom size.
 */
export function resolvePaper(code: PassportPaperCode, orientation: SheetOrientation, custom?: PaperMm | null): PaperMm {
  let base: PaperMm;
  if (code === "CUSTOM") {
    if (!custom) throw new Error("Enter the custom paper width and height");
    const { widthMm, heightMm } = custom;
    if (!(widthMm > 0) || !(heightMm > 0)) throw new Error("Paper width and height must be more than 0 mm");
    if (widthMm > MAX_PAPER_MM || heightMm > MAX_PAPER_MM) throw new Error(`Paper can be at most ${MAX_PAPER_MM} mm on a side`);
    base = { widthMm, heightMm };
  } else {
    const known = PASSPORT_PAPER[code];
    if (!known) throw new Error(`Unsupported paper size "${String(code)}"`);
    base = { widthMm: known.widthMm, heightMm: known.heightMm };
  }
  const short = Math.min(base.widthMm, base.heightMm);
  const long = Math.max(base.widthMm, base.heightMm);
  return orientation === "LANDSCAPE" ? { widthMm: long, heightMm: short } : { widthMm: short, heightMm: long };
}

export function isPassportPaperCode(v: unknown): v is PassportPaperCode {
  return v === "A4" || v === "4X6" || v === "CUSTOM";
}
