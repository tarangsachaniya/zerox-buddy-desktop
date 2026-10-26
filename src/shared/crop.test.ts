import { describe, expect, test } from "vitest";

import { clampCrop, isFull, toRotated, toUnrotated } from "./crop";

const r = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
const close = (a: object, b: object) => {
  for (const [k, v] of Object.entries(b)) expect((a as Record<string, number>)[k]).toBeCloseTo(v as number);
};

describe("crop rotation", () => {
  test("a quarter turn clockwise moves the top-left corner to the top-right", () => {
    close(toRotated(r, 90), { x: 0.4, y: 0.1, w: 0.4, h: 0.3 });
  });

  test.each([0, 90, 180, 270] as const)("toUnrotated undoes toRotated at %i°", (rotation) => {
    close(toUnrotated(toRotated(r, rotation), rotation), r);
  });

  test("four quarter turns come back to the start", () => {
    close(toRotated(toRotated(toRotated(toRotated(r, 90), 90), 90), 90), r);
  });
});

describe("clampCrop / isFull", () => {
  test("keeps the box inside the image and not too small", () => {
    expect(clampCrop({ x: 0.9, y: -0.2, w: 0.5, h: 0.01 })).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.05 });
  });

  test("a whole-image box counts as no crop", () => {
    expect(isFull({ x: 0, y: 0, w: 1, h: 1 })).toBe(true);
    expect(isFull(null)).toBe(true);
    expect(isFull(r)).toBe(false);
  });
});
