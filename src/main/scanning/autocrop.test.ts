import { describe, expect, test } from "vitest";

import { findCardBox } from "./autocrop";

/** A w × h BGRA image filled with `bg`, with an optional rectangle of `fg`. */
function image(w: number, h: number, bg: number, card?: { x: number; y: number; w: number; h: number; fg: number }): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inCard = card && x >= card.x && x < card.x + card.w && y >= card.y && y < card.y + card.h;
      const v = inCard ? card.fg : bg;
      px.set([v, v, v, 255], (y * w + x) * 4);
    }
  }
  return px;
}

describe("findCardBox", () => {
  test("finds a light card on the dark lid", () => {
    // 100 × 70 like the scanned corner; a 79 × 50 card (1.58:1) off-centre.
    const box = findCardBox(image(100, 70, 40, { x: 12, y: 8, w: 79, h: 50, fg: 220 }), 100, 70);
    expect(box).not.toBeNull();
    expect(box!.x).toBeCloseTo(0.12, 1);
    expect(box!.y).toBeCloseTo(8 / 70, 1);
    expect(box!.w).toBeCloseTo(0.79, 1);
    expect(box!.h).toBeCloseTo(50 / 70, 1);
  });

  test("keeps the whole scan when nothing stands out (blank or white lid)", () => {
    expect(findCardBox(image(100, 70, 245), 100, 70)).toBeNull();
  });

  test("keeps the whole scan when what it finds isn't card-shaped", () => {
    // A long strip (3:1), like the edge of a document, not a card.
    expect(findCardBox(image(100, 70, 40, { x: 5, y: 20, w: 90, h: 30, fg: 220 }), 100, 70)).toBeNull();
  });

  test("ignores a too-small image", () => {
    expect(findCardBox(new Uint8Array(10 * 10 * 4), 10, 10)).toBeNull();
  });
});
