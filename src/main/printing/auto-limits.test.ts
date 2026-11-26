import { describe, expect, test } from "vitest";

import { BatchGate, DEFAULT_LIMITS, limitsOf, needsReview } from "./auto-limits";

describe("big requests", () => {
  test("over the limit, pages only (copies don't count)", () => {
    expect(needsReview({ totalPages: 51 }, 50)).toBe(true);
    expect(needsReview({ totalPages: 50 }, 50)).toBe(false);
    expect(needsReview({ totalPages: 500 }, 0)).toBe(false);
  });
  test("an older server gets the defaults", () => {
    expect(limitsOf({})).toEqual(DEFAULT_LIMITS);
    expect(limitsOf({ bigJobPreviewPages: 0 }).bigJobPreviewPages).toBe(0);
  });
});

describe("batch pause", () => {
  function gate() {
    let t = 0;
    const g = new BatchGate(() => t);
    return { g, advance: (ms: number) => (t += ms) };
  }

  test("stops starting after N, rests once they finish, then resumes", () => {
    const { g, advance } = gate();
    for (let i = 0; i < 10; i++) {
      expect(g.canStart()).toBe(true);
      g.started(10);
    }
    expect(g.canStart()).toBe(false);
    expect(g.settled(3, 5)).toBe(false);
    expect(g.view(3, { batchPauseAfter: 10, batchPauseMinutes: 5 })?.state).toBe("finishing");
    expect(g.settled(0, 5)).toBe(true);
    expect(g.view(0, { batchPauseAfter: 10, batchPauseMinutes: 5 })?.state).toBe("paused");
    advance(4 * 60_000);
    expect(g.canStart()).toBe(false);
    advance(60_000);
    expect(g.canStart()).toBe(true);
    expect(g.view(0, { batchPauseAfter: 10, batchPauseMinutes: 5 })).toBeNull();
  });

  test("Continue now ends the rest at once", () => {
    const { g } = gate();
    g.started(1);
    g.settled(0, 5);
    expect(g.canStart()).toBe(false);
    g.continueNow();
    expect(g.canStart()).toBe(true);
  });

  test("an empty queue resets the count; 0 never pauses", () => {
    const { g } = gate();
    for (let i = 0; i < 9; i++) g.started(10);
    g.idle();
    g.started(10);
    expect(g.canStart()).toBe(true);
    for (let i = 0; i < 50; i++) g.started(0);
    expect(g.canStart()).toBe(true);
  });
});
