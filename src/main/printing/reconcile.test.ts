import { describe, expect, test, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "." } }));

import type { QueueJob } from "../../shared/types";
import { decide, removeScript, spoolName } from "./reconcile";

const job = (deviceId = "dev-1") =>
  ({ id: "job-1", status: "PRINTING", lastAttempt: { id: "8f2c1d3e-0000", status: "PRINTING", error: null, printerId: "p1", deviceId } }) as Pick<
    QueueJob,
    "id" | "status" | "lastAttempt"
  >;
const ledger = { jobId: "job-1", printerId: "p1", phase: "sent" as const, at: new Date().toISOString() };
const base = { deviceId: "dev-1", busy: false, pendingReport: false };

describe("reconcile: settling a job this computer holds but isn't printing", () => {
  test("leaves alone what isn't ours, what's in progress, and what has a report on its way", () => {
    expect(decide({ ...base, job: job("dev-2"), ledger, inSpooler: false }).kind).toBe("skip");
    expect(decide({ ...base, busy: true, job: job(), ledger, inSpooler: false }).kind).toBe("skip");
    expect(decide({ ...base, pendingReport: true, job: job(), ledger: null, inSpooler: null }).kind).toBe("skip");
  });
  test("never handed to a printer: back to the queue", () => {
    expect(decide({ ...base, job: job(), ledger: null, inSpooler: null }).kind).toBe("requeue");
  });
  test("still in the Windows queue: still printing", () => {
    expect(decide({ ...base, job: job(), ledger, inSpooler: true }).kind).toBe("still_spooling");
  });
  test("handed off and gone, or the queue can't be read: unknown, never printed or failed on a guess", () => {
    expect(decide({ ...base, job: job(), ledger, inSpooler: false }).kind).toBe("unknown");
    expect(decide({ ...base, job: job(), ledger: { ...ledger, phase: "printing" }, inSpooler: null }).kind).toBe("unknown");
  });
  test("print files are named after the attempt so the queue entry can be found again", () => {
    expect(spoolName("8f2c1d3e-1234")).toBe("zx-8f2c1d3e.pdf");
    expect(spoolName("8f2c1d3e-1234", "-01", "jpg")).toBe("zx-8f2c1d3e-01.jpg");
  });
});

describe("Stop: clearing the Windows queue", () => {
  test("removes only this attempt's documents, by name", () => {
    const script = removeScript("0a1b2c3d-1111-2222-3333-444455556666")!;
    expect(script).toContain("-like '*zx-0a1b2c3d*'");
    expect(script).toContain("Remove-PrintJob");
    expect(script).toContain("$env:ZX_PRINTER");
  });
  test("refuses an id that isn't hex (nothing reaches PowerShell)", () => {
    expect(removeScript("'; Remove-Item C:\ -Recurse")).toBeNull();
  });
});
