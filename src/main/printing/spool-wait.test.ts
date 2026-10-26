import { describe, expect, test, vi } from "vitest";

vi.mock("../log", () => ({ log: { warn: () => {}, info: () => {} } }));

import { minimumPrintMs, snapshotQueue, waitForPrintComplete } from "./spool-wait";
import type { SpoolDeps } from "./spool-wait";

/**
 * A fake clock and PowerShell: `queue` and `status` are read on each call as
 * functions of elapsed time, so a test describes what Windows reports when.
 */
function fake(opts: { queue: (t: number) => number[] | Error; status: (t: number) => number | Error }) {
  let t = 0;
  const deps: SpoolDeps = {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    run: async (script) => {
      const v = script.includes("Get-PrintJob") ? opts.queue(t) : opts.status(t);
      if (v instanceof Error) throw v;
      return Array.isArray(v) ? v.join(",") : String(v);
    },
  };
  return { deps, elapsed: () => t };
}

describe("waitForPrintComplete", () => {
  test("a queue that empties at once still waits for the paper at the printer's speed", async () => {
    const f = fake({ queue: () => [], status: () => 0 });
    const outcome = await waitForPrintComplete({ printerName: "P", sheets: 10, pagesPerMinute: 20, before: [] }, f.deps);
    expect(outcome).toBe("done");
    expect(f.elapsed()).toBeGreaterThanOrEqual(minimumPrintMs(10, 20)); // 15 s warm-up + 30 s
  });

  test("waits for our job to leave the queue, ignoring jobs that were there before", async () => {
    const f = fake({ queue: (t) => (t < 100_000 ? [7, 8] : [7]), status: () => 0 });
    const outcome = await waitForPrintComplete({ printerName: "P", sheets: 1, pagesPerMinute: 60, before: [7] }, f.deps);
    expect(outcome).toBe("done");
    expect(f.elapsed()).toBeGreaterThanOrEqual(100_000);
  });

  test("keeps waiting while the printer reports Printing, and reports a jam while it lasts", async () => {
    const problems: (string | null)[] = [];
    const f = fake({ queue: () => [], status: (t) => (t < 60_000 ? 11 : t < 90_000 ? 4 : 0) });
    const outcome = await waitForPrintComplete(
      { printerName: "P", sheets: 1, pagesPerMinute: 60, before: [], onProblem: (m) => problems.push(m) },
      f.deps,
    );
    expect(outcome).toBe("done");
    expect(f.elapsed()).toBeGreaterThanOrEqual(90_000);
    expect(problems).toEqual(["Paper jam", null]);
  });

  test("an unreadable queue falls back to the speed floor and says it's unsure", async () => {
    const f = fake({ queue: () => new Error("no PrintManagement"), status: () => 0 });
    const outcome = await waitForPrintComplete({ printerName: "P", sheets: 4, pagesPerMinute: 15, before: null }, f.deps);
    expect(outcome).toBe("uncertain");
    expect(f.elapsed()).toBeGreaterThanOrEqual(minimumPrintMs(4, 15));
  });

  test("a stuck queue stops at the deadline as unsure, never hangs", async () => {
    const f = fake({ queue: () => [9], status: () => 0 });
    const outcome = await waitForPrintComplete({ printerName: "P", sheets: 2, pagesPerMinute: 30, before: [] }, f.deps);
    expect(outcome).toBe("uncertain");
    expect(f.elapsed()).toBeLessThan(31 * 60 * 1000);
  });

  test("a driver with no status is fine: the floor still applies", async () => {
    const f = fake({ queue: () => [], status: () => new Error("no status") });
    const outcome = await waitForPrintComplete({ printerName: "P", sheets: 3, pagesPerMinute: null, before: [] }, f.deps);
    expect(outcome).toBe("done");
    expect(f.elapsed()).toBeGreaterThanOrEqual(minimumPrintMs(3, 15));
  });
});

describe("snapshotQueue", () => {
  test("returns the queued ids, or null when the queue can't be read", async () => {
    expect(await snapshotQueue("P", fake({ queue: () => [3, 4], status: () => 0 }).deps)).toEqual([3, 4]);
    expect(await snapshotQueue("P", fake({ queue: () => [], status: () => 0 }).deps)).toEqual([]);
    expect(await snapshotQueue("P", fake({ queue: () => new Error("x"), status: () => 0 }).deps)).toBeNull();
  });
});
