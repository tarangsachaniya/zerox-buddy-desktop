import { execFile } from "node:child_process";

import type { QueueJob } from "../../shared/types";
import type { LedgerEntry } from "./ledger";

/**
 * Settles jobs this computer holds on the server but isn't working on any
 * more: it restarted mid-job, a report was lost, or the app was asleep.
 * Runs after every queue refresh (it used to run once per start, so a job
 * whose report was lost while the app kept running sat "Printing" forever).
 *
 * Decided from evidence only, and nothing is ever printed again on a guess:
 *
 *   our pending report    leave it: the outbox will deliver the real outcome
 *   no ledger entry       never handed to the printer → FAILED, nothing on
 *                         paper, so the server puts it back in the queue
 *   in the Windows queue  still printing → leave it PRINTING, look again later
 *   handed off, gone      can't tell if it came out → UNKNOWN, and ask the
 *                         counter to check the tray
 */

export type Decision =
  | { kind: "skip" }
  | { kind: "requeue" }
  | { kind: "still_spooling" }
  | { kind: "unknown" };

export function decide(args: {
  job: Pick<QueueJob, "id" | "status" | "lastAttempt">;
  deviceId: string | undefined;
  busy: boolean;
  pendingReport: boolean;
  ledger: LedgerEntry | null;
  inSpooler: boolean | null;
}): Decision {
  const attempt = args.job.lastAttempt;
  if (!attempt || attempt.deviceId !== args.deviceId || args.busy || args.pendingReport) return { kind: "skip" };
  if (!args.ledger) return { kind: "requeue" };
  // null: the queue couldn't be read. Not evidence of anything, so ask a person.
  if (args.inSpooler) return { kind: "still_spooling" };
  return { kind: "unknown" };
}

/** The file name a print is sent under, so the Windows queue entry can be found again after a restart. */
export function spoolName(attemptId: string, suffix = "", ext = "pdf"): string {
  return `zx-${attemptId.slice(0, 8)}${suffix}.${ext}`;
}

const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

/**
 * Whether a Windows print queue still has a document sent for this attempt
 * (SumatraPDF names it after the file). Null when the queue can't be read.
 */
export function inWindowsQueue(printerName: string, attemptId: string): Promise<boolean | null> {
  const token = attemptId.slice(0, 8);
  if (!/^[0-9a-f]{8}$/i.test(token)) return Promise.resolve(null);
  const script = `$ErrorActionPreference='Stop'; @(Get-PrintJob -PrinterName $env:ZX_PRINTER | Where-Object { $_.DocumentName -like '*zx-${token}*' }).Count`;
  return new Promise((resolve) => {
    execFile(
      POWERSHELL,
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 15_000, windowsHide: true, env: { ...process.env, ZX_PRINTER: printerName } },
      (err, stdout) => {
        if (err) return resolve(null);
        const n = Number(String(stdout).trim());
        resolve(Number.isFinite(n) ? n > 0 : null);
      },
    );
  });
}
