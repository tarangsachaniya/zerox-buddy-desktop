import { app } from "electron";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ApiError, deviceRequest } from "../auth/api-client";
import { getSession } from "../auth/token-store";
import { log } from "../log";

/**
 * How a print ended, on its way to the server.
 *
 * Every final report (COMPLETED, FAILED, UNKNOWN) is written to disk before
 * it is sent, and stays there until the server has it. Offline, a server
 * restart, a dropped response or a crash only delay it. Before this, a report
 * that didn't get through was simply lost: the job sat "Printing" on the
 * server until someone restarted the app, and a lost COMPLETED fell back to
 * FAILED, which offered "Print again" for paper already on the tray.
 *
 * Reports for one attempt go in order. The server treats a repeated report as
 * a no-op, so resending one whose response was lost is safe; a 404/409 means
 * it's already settled there (or can't be), so the entry is dropped.
 */

export type FinalStatus = "COMPLETED" | "FAILED" | "UNKNOWN";

export type StatusReport = {
  attemptId: string;
  jobId: string;
  status: FinalStatus;
  error?: string;
  pagesSent?: boolean;
  /** spooler_gone, spooler_uncertain, operator_confirmed, recovered… */
  evidence?: string;
  at: string;
};

type Stored = StatusReport & { shopId: string; tries: number; lastError?: string };

function file(): string {
  return join(app.getPath("userData"), "status-outbox.json");
}

function read(): Stored[] {
  try {
    return JSON.parse(readFileSync(file(), "utf8")) as Stored[];
  } catch {
    return [];
  }
}

/** Atomic: write a temp file, then rename over the old one. */
function write(entries: Stored[]): void {
  const tmp = `${file()}.tmp`;
  writeFileSync(tmp, JSON.stringify(entries));
  renameSync(tmp, file());
}

/** Attempts with an outcome still on its way: reconciliation leaves their jobs alone. */
export function pendingAttemptIds(): Set<string> {
  const shopId = getSession()?.shop.id;
  return new Set(read().filter((e) => e.shopId === shopId).map((e) => e.attemptId));
}

export function pendingCount(): number {
  return pendingAttemptIds().size;
}

export type Sender = (r: StatusReport) => Promise<unknown>;

const send: Sender = (r) =>
  deviceRequest(`/attempts/${r.attemptId}/status`, {
    method: "POST",
    body: { status: r.status, error: r.error, pagesSent: r.pagesSent, evidence: r.evidence },
  });

/** Gone for good on the server's side: retrying can't help. */
function settledThere(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 404 || err.status === 409 || err.status === 400);
}

let flushing: Promise<void> | null = null;

async function flushPass(sender: Sender): Promise<void> {
  const shopId = getSession()?.shop.id;
  if (!shopId) return;
  for (const entry of read().filter((e) => e.shopId === shopId)) {
    const { shopId: _, tries: __, lastError: ___, ...report } = entry;
    try {
      await sender(report);
      write(read().filter((e) => !(e.attemptId === entry.attemptId && e.at === entry.at && e.status === entry.status)));
      log.info(`[status] ${entry.jobId}/${entry.attemptId.slice(0, 8)} ${entry.status} delivered${entry.evidence ? ` (${entry.evidence})` : ""}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (settledThere(err)) {
        write(read().filter((e) => !(e.attemptId === entry.attemptId && e.at === entry.at)));
        log.warn(`[status] ${entry.jobId}/${entry.attemptId.slice(0, 8)} ${entry.status} dropped: ${reason}`);
        continue;
      }
      // Offline or server trouble: the rest would fail too. Kept for the next pass.
      write(read().map((e) => (e.attemptId === entry.attemptId && e.at === entry.at ? { ...e, tries: e.tries + 1, lastError: reason } : e)));
      log.warn(`[status] ${entry.jobId}/${entry.attemptId.slice(0, 8)} ${entry.status} not delivered yet: ${reason}`);
      return;
    }
  }
}

/** Sends everything waiting, oldest first; one pass at a time. */
export function flushStatus(sender: Sender = send): Promise<void> {
  if (flushing) return flushing;
  flushing = flushPass(sender).finally(() => {
    flushing = null;
  });
  return flushing;
}

/**
 * Records a final outcome and tries to deliver it now. Never throws for a
 * network problem: the report stays queued and the next flush sends it.
 */
export async function settle(report: Omit<StatusReport, "at">, sender: Sender = send): Promise<void> {
  const shopId = getSession()?.shop.id;
  if (!shopId) return;
  write([...read(), { ...report, at: new Date().toISOString(), shopId, tries: 0 }]);
  // Waits for a pass already running, then sends this one too.
  if (flushing) await flushing.catch(() => {});
  await flushStatus(sender).catch(() => {});
}
