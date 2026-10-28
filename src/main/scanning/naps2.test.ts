import { describe, expect, test, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: false } }));
vi.mock("../log", () => ({ log: { info: vi.fn(), warn: vi.fn() } }));

import { mergeDeviceLists, parseDeviceList } from "./naps2";

describe("mergeDeviceLists", () => {
  test("lists a device once, under the first driver that sees it", () => {
    const out = mergeDeviceLists([
      ["wia", ["HP LaserJet MFP"]],
      ["escl", ["hp laserjet mfp", "Canon G3010"]],
      ["twain", ["Canon G3010"]],
    ]);
    expect(out).toEqual([
      { id: "wia:HP LaserJet MFP", driver: "wia", name: "HP LaserJet MFP" },
      { id: "escl:Canon G3010", driver: "escl", name: "Canon G3010" },
    ]);
  });

  test("skips a driver that failed", () => {
    expect(mergeDeviceLists([["wia", null], ["escl", ["Epson L3250"]], ["twain", null]])).toEqual([
      { id: "escl:Epson L3250", driver: "escl", name: "Epson L3250" },
    ]);
  });
});

describe("parseDeviceList", () => {
  test("drops blank and error lines", () => {
    expect(parseDeviceList("Scanner A\r\n\r\nError: no DSM\nScanner A\n")).toEqual(["Scanner A"]);
  });
});
