/**
 * Thrown wherever a job's work notices the counter pressed Stop. Carries the
 * attempt id when the job was already claimed, so the caller can clear the
 * Windows queue and tell the server which attempt ended.
 */
export class CancelledError extends Error {
  constructor(readonly attemptId?: string) {
    super("Stopped at the counter");
    this.name = "CancelledError";
  }
}

export function throwIfStopped(signal: AbortSignal | undefined, attemptId?: string): void {
  if (signal?.aborted) throw new CancelledError(attemptId);
}

/** Sleeps, but ends at once with CancelledError when the signal fires. */
export function stoppableSleep(sleep: (ms: number) => Promise<void>, ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.reject(new CancelledError());
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(new CancelledError());
    signal.addEventListener("abort", onAbort, { once: true });
    sleep(ms).then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}
