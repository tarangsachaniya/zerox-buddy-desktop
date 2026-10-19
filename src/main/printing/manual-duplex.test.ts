import { PDFDocument } from "pdf-lib";
import { describe, expect, test } from "vitest";

import { splitManualDuplex } from "./manual-duplex";

/** n portrait pages whose width is 100 + index, so each page is identifiable. */
async function sheets(n: number, landscape = false): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) {
    const w = 100 + i;
    doc.addPage(landscape ? [200 + i, w] : [w, 200 + i]);
  }
  return doc.save();
}

/** Page ids of a split pass: 100 + original index, or 0 for a blank pad. */
async function ids(bytes: Uint8Array): Promise<number[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => {
    const { width, height } = p.getSize();
    const w = Math.min(width, height);
    return w;
  });
}

async function rotations(bytes: Uint8Array): Promise<number[]> {
  return (await PDFDocument.load(bytes)).getPages().map((p) => p.getRotation().angle);
}

describe("splitManualDuplex", () => {
  test("two pages: page 1 on the front, page 2 on the back", async () => {
    const r = await splitManualDuplex(await sheets(2), 1, "FORWARD", "LONG");
    expect(await ids(r.front)).toEqual([100]);
    expect(await ids(r.back)).toEqual([101]);
    expect([r.frontSheets, r.backSheets]).toEqual([1, 1]);
  });

  test("odd page count pads the last back side with a blank, dropping nothing", async () => {
    const r = await splitManualDuplex(await sheets(3), 1, "FORWARD", "LONG");
    expect(await ids(r.front)).toEqual([100, 102]);
    // Blank takes the size of the last real sheet (index 2).
    expect(await ids(r.back)).toEqual([101, 102]);
    expect(r.backSheets).toBe(2);
  });

  test("REVERSE prints the back sides last to first", async () => {
    const r = await splitManualDuplex(await sheets(4), 1, "REVERSE", "LONG");
    expect(await ids(r.front)).toEqual([100, 102]);
    expect(await ids(r.back)).toEqual([103, 101]);
  });

  test("odd count with REVERSE puts the blank first", async () => {
    const r = await splitManualDuplex(await sheets(3), 1, "REVERSE", "LONG");
    expect(await ids(r.back)).toEqual([102, 101]); // blank (sized like #2) then page 2
    expect(r.backSheets).toBe(2);
  });

  test("copies never share a sheet", async () => {
    const r = await splitManualDuplex(await sheets(3), 2, "FORWARD", "LONG");
    // Per copy: fronts 1,3 / backs 2,blank → two copies = 4 fronts, 4 backs.
    expect([r.frontSheets, r.backSheets]).toEqual([4, 4]);
    expect(await ids(r.front)).toEqual([100, 102, 100, 102]);
  });

  test("short-edge turns portrait backs 180°, long-edge leaves them", async () => {
    const short = await splitManualDuplex(await sheets(2), 1, "FORWARD", "SHORT");
    expect(await rotations(short.back)).toEqual([180]);
    expect(await rotations(short.front)).toEqual([0]);
    const long = await splitManualDuplex(await sheets(2), 1, "FORWARD", "LONG");
    expect(await rotations(long.back)).toEqual([0]);
  });

  test("landscape sheets are the other way round", async () => {
    const long = await splitManualDuplex(await sheets(2, true), 1, "FORWARD", "LONG");
    expect(await rotations(long.back)).toEqual([180]);
    const short = await splitManualDuplex(await sheets(2, true), 1, "FORWARD", "SHORT");
    expect(await rotations(short.back)).toEqual([0]);
  });

  test("EVEN first prints the even pages, then the odd ones", async () => {
    const r = await splitManualDuplex(await sheets(4), 1, "FORWARD", "LONG", "EVEN");
    expect(await ids(r.front)).toEqual([101, 103]);
    expect(await ids(r.back)).toEqual([100, 102]);
  });

  test("EVEN first with an odd count pads the first pass, and REVERSE turns the odd pages round", async () => {
    const r = await splitManualDuplex(await sheets(3), 1, "REVERSE", "LONG", "EVEN");
    expect(await ids(r.front)).toEqual([101, 102]); // page 2, then a blank sized like #3
    expect(await ids(r.back)).toEqual([102, 100]);
    expect([r.frontSheets, r.backSheets]).toEqual([2, 2]);
  });

  test("EVEN first still turns the even pages for short-edge", async () => {
    const r = await splitManualDuplex(await sheets(2), 1, "FORWARD", "SHORT", "EVEN");
    expect(await rotations(r.front)).toEqual([180]);
    expect(await rotations(r.back)).toEqual([0]);
  });

  test("a single page leaves the whole back blank", async () => {
    const r = await splitManualDuplex(await sheets(1), 1, "FORWARD", "LONG");
    expect([r.frontSheets, r.backSheets]).toEqual([1, 1]);
  });
});
