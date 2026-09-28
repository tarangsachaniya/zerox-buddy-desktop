import { describe, expect, test } from "vitest";

import { toDetected } from "./discovery";

function row(over: Partial<Parameters<typeof toDetected>[0][number]>) {
  return {
    Name: "Printer",
    DriverName: "Some Driver",
    PrinterStatus: 0,
    WorkOffline: false,
    Valid: true,
    Color: false,
    Duplex: false,
    Kinds: [] as string[],
    ...over,
  };
}

describe("toDetected", () => {
  test("a thermal/receipt printer (no standard paper kind) is listed, not dropped", () => {
    const out = toDetected([row({ Name: "POS-80 Series", Kinds: ["Custom"] })]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ systemName: "POS-80 Series", paperSizes: [] });
  });

  test("a standard document printer keeps its detected A4/A3 kinds", () => {
    const out = toDetected([row({ Name: "Office Laser", Kinds: ["A4", "A3", "Letter"] })]);
    expect(out[0]?.paperSizes).toEqual(["A4", "A3"]);
  });

  test("a virtual printer is still filtered out", () => {
    const out = toDetected([row({ Name: "Microsoft Print to PDF", DriverName: "Microsoft PDF" })]);
    expect(out).toHaveLength(0);
  });

  test("a row with no name is skipped", () => {
    const out = toDetected([row({ Name: "" })]);
    expect(out).toHaveLength(0);
  });
});
