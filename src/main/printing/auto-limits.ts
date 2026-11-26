import type { AutoPause } from "../../shared/types";

/**
 * Two brakes on automatic printing, both set per shop in Settings:
 *
 *   big requests  more pages than bigJobPreviewPages (copies not counted) are
 *                 held until the counter checks them (Preview → Print it);
 *                 the window chimes while one waits
 *   batch pause   after batchPauseAfter requests in a row, auto-print stops
 *                 taking new ones; once those have finished it rests for
 *                 batchPauseMinutes, unless the counter presses Continue now
 *
 * Pure (time comes in through `now`), so every rule is unit tested.
 */

export { DEFAULT_LIMITS, limitsOf } from "../../shared/print-limits";
export type { PrintLimits } from "../../shared/print-limits";
import type { PrintLimits } from "../../shared/print-limits";

/** Pages in the file(s) only: copies don't make a request "big". */
export function needsReview(job: { totalPages: number }, limit: number): boolean {
  return limit > 0 && job.totalPages > limit;
}

export class BatchGate {
  private streak = 0;
  /** Reached the limit: no new automatic starts; waiting for the running ones to finish. */
  private holding = false;
  private until: number | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  private expire(): void {
    if (this.until !== null && this.now() >= this.until) {
      this.until = null;
      this.streak = 0;
    }
  }

  canStart(): boolean {
    this.expire();
    return !this.holding && this.until === null;
  }

  /** One request started automatically. */
  started(after: number): void {
    if (after <= 0) return;
    this.streak++;
    if (this.streak >= after) {
      this.holding = true;
      this.streak = 0;
    }
  }

  /**
   * Called with how many automatic requests are still printing. Once the last
   * of a full run is out, the rest begins. Returns true when it just began.
   */
  settled(running: number, minutes: number): boolean {
    if (!this.holding || running > 0) return false;
    this.holding = false;
    this.until = this.now() + Math.max(1, minutes) * 60_000;
    return true;
  }

  /** Nothing waiting and nothing printing: the run is over, the count starts again. */
  idle(): void {
    if (!this.holding && this.until === null) this.streak = 0;
  }

  continueNow(): void {
    this.streak = 0;
    this.holding = false;
    this.until = null;
  }

  pausedUntil(): number | null {
    this.expire();
    return this.until;
  }

  view(running: number, limits: Pick<PrintLimits, "batchPauseAfter" | "batchPauseMinutes">): AutoPause | null {
    this.expire();
    if (this.holding) return { state: "finishing", after: limits.batchPauseAfter, running, minutes: limits.batchPauseMinutes };
    if (this.until !== null) return { state: "paused", after: limits.batchPauseAfter, until: new Date(this.until).toISOString() };
    return null;
  }
}
