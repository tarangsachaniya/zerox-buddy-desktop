import { describe, expect, it } from "vitest";

import {
  clampCrop,
  cropFits,
  cropZoom,
  initialCrop,
  moveCrop,
  outputPixelSize,
  renderTransform,
  resizeCrop,
  rotateCrop90,
  setFineRotation,
  viewSize,
  zoomCrop,
} from "./crop";

const PASSPORT = 35 / 45;
const landscapePhoto = { width: 4000, height: 3000 };
const portraitPhoto = { width: 3000, height: 4000 };

describe("initialCrop", () => {
  it("takes the full height of a landscape photo at the passport ratio", () => {
    const c = initialCrop(landscapePhoto, PASSPORT);
    expect(c.w).toBeCloseTo(3000 * PASSPORT, 3);
    expect(c.w / PASSPORT).toBeCloseTo(3000, 3);
    expect([c.cx, c.cy]).toEqual([0, 0]);
  });

  it("takes the full width of a tall photo with a wide ratio", () => {
    const c = initialCrop(portraitPhoto, 2);
    expect(c.w).toBeCloseTo(3000, 3);
  });

  it("swaps the limits after a quarter turn", () => {
    const c = initialCrop(landscapePhoto, PASSPORT, 90);
    // Turned, the photo is 3000 wide × 4000 tall: the width limits it.
    expect(c.w).toBeCloseTo(3000, 3);
  });

  it("refuses a zero or negative aspect", () => {
    expect(() => initialCrop(landscapePhoto, 0)).toThrow();
    expect(() => initialCrop(landscapePhoto, -1)).toThrow();
  });
});

describe("clampCrop", () => {
  it("pulls a window that hangs off the photo back onto it", () => {
    const start = initialCrop(landscapePhoto, PASSPORT);
    const moved = moveCrop(start, 5000, 0, landscapePhoto, PASSPORT);
    expect(cropFits(moved, landscapePhoto, PASSPORT)).toBe(true);
    // Full height, so it can only slide sideways to the right edge.
    expect(moved.cx).toBeCloseTo(2000 - start.w / 2, 3);
    expect(moved.cy).toBeCloseTo(0, 3);
  });

  it("caps an oversized window", () => {
    const c = resizeCrop(initialCrop(landscapePhoto, PASSPORT), 99999, landscapePhoto, PASSPORT);
    expect(c.w).toBeCloseTo(3000 * PASSPORT, 3);
  });

  it("keeps the corners on the photo after a fine rotation", () => {
    const c = setFineRotation(initialCrop(landscapePhoto, PASSPORT), 10, landscapePhoto, PASSPORT);
    expect(c.fineDeg).toBe(10);
    expect(cropFits(c, landscapePhoto, PASSPORT)).toBe(true);
    expect(c.w).toBeLessThan(3000 * PASSPORT);
    expect(cropFits({ ...c, w: c.w * 1.01 }, landscapePhoto, PASSPORT)).toBe(false);
  });

  it("limits the fine rotation to ±15°", () => {
    expect(setFineRotation(initialCrop(landscapePhoto, PASSPORT), 40, landscapePhoto, PASSPORT).fineDeg).toBe(15);
    expect(setFineRotation(initialCrop(landscapePhoto, PASSPORT), -40, landscapePhoto, PASSPORT).fineDeg).toBe(-15);
  });

  it("survives junk values", () => {
    const c = clampCrop({ cx: Number.NaN, cy: Infinity, w: Number.NaN, rotation90: 0, fineDeg: Number.NaN }, landscapePhoto, PASSPORT);
    expect(cropFits(c, landscapePhoto, PASSPORT)).toBe(true);
  });
});

describe("aspect ratio", () => {
  it("never changes, whatever the operator does", () => {
    let c = initialCrop(landscapePhoto, PASSPORT);
    c = zoomCrop(c, 2.5, landscapePhoto, PASSPORT);
    c = moveCrop(c, 700, -300, landscapePhoto, PASSPORT);
    c = rotateCrop90(c, "cw", landscapePhoto, PASSPORT);
    c = setFineRotation(c, -7, landscapePhoto, PASSPORT);
    const out = outputPixelSize(35, 45, 600);
    const [a, b, , , e, f] = renderTransform(c, out);
    const k = Math.hypot(a, b);
    // The window maps onto the whole output: width and height scale alike.
    expect((c.w / PASSPORT) * k).toBeCloseTo(out.height, 0);
    expect(c.w * k).toBeCloseTo(out.width, 6);
    expect(Number.isFinite(e) && Number.isFinite(f)).toBe(true);
    expect(cropFits(c, landscapePhoto, PASSPORT)).toBe(true);
  });
});

describe("zoom", () => {
  it("round-trips through zoomCrop and cropZoom", () => {
    const c = zoomCrop(initialCrop(landscapePhoto, PASSPORT), 3, landscapePhoto, PASSPORT);
    expect(cropZoom(c, landscapePhoto, PASSPORT)).toBeCloseTo(3, 6);
    expect(cropZoom(zoomCrop(c, 0.2, landscapePhoto, PASSPORT), landscapePhoto, PASSPORT)).toBeCloseTo(1, 6);
  });
});

describe("rotateCrop90", () => {
  it("goes all the way round in four turns, either way", () => {
    let c = initialCrop(landscapePhoto, PASSPORT);
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      c = rotateCrop90(c, "cw", landscapePhoto, PASSPORT);
      seen.push(c.rotation90);
    }
    expect(seen).toEqual([90, 180, 270, 0]);
    expect(rotateCrop90(c, "ccw", landscapePhoto, PASSPORT).rotation90).toBe(270);
  });

  it("keeps the zoom", () => {
    const c = zoomCrop(initialCrop(landscapePhoto, PASSPORT), 2, landscapePhoto, PASSPORT);
    expect(cropZoom(rotateCrop90(c, "cw", landscapePhoto, PASSPORT), landscapePhoto, PASSPORT)).toBeCloseTo(2, 6);
  });

  it("turns the view", () => {
    expect(viewSize(landscapePhoto, 90)).toMatchObject({ width: expect.closeTo(3000, 6), height: expect.closeTo(4000, 6) });
    expect(viewSize(landscapePhoto, 180)).toMatchObject({ width: expect.closeTo(4000, 6), height: expect.closeTo(3000, 6) });
  });
});

describe("outputPixelSize", () => {
  it("is the physical size at the print DPI", () => {
    expect(outputPixelSize(35, 45, 300)).toEqual({ width: 413, height: 531 });
    expect(outputPixelSize(35, 45, 600)).toEqual({ width: 827, height: 1063 });
    expect(outputPixelSize(50.8, 50.8, 300)).toEqual({ width: 600, height: 600 });
  });

  it("refuses bad sizes and resolutions", () => {
    expect(() => outputPixelSize(0, 45, 300)).toThrow();
    expect(() => outputPixelSize(35, -1, 300)).toThrow();
    expect(() => outputPixelSize(35, 45, 10)).toThrow();
  });
});

describe("renderTransform", () => {
  it("maps the window's centre to the middle of the output, unturned", () => {
    const c = { cx: 100, cy: -50, w: 700, rotation90: 0 as const, fineDeg: 0 };
    const out = { width: 350, height: 450 };
    const [a, b, cc, d, e, f] = renderTransform(c, out);
    // The source point at the window centre is (100, -50) unturned.
    expect(a * 100 + cc * -50 + e).toBeCloseTo(175);
    expect(b * 100 + d * -50 + f).toBeCloseTo(225);
    expect(a).toBeCloseTo(0.5);
  });

  it("follows a quarter turn clockwise", () => {
    const c = { cx: 0, cy: 0, w: 100, rotation90: 90 as const, fineDeg: 0 };
    const [a, b, cc, d, e, f] = renderTransform(c, { width: 100, height: 100 });
    // The source's right edge point (10, 0) lands below the centre after turning clockwise.
    expect(a * 10 + cc * 0 + e).toBeCloseTo(50);
    expect(b * 10 + d * 0 + f).toBeCloseTo(60);
  });
});
