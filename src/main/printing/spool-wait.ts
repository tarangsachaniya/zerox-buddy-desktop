import { execFile } from "node:child_process";

import { log } from "../log";

/**
 * Waits until the Windows queue for a printer is empty, so "printed" and the
 * flip-the-paper prompt follow the paper, not the spooler hand-off.
 *
 * A printer's jobs run one at a time here, so an empty queue means our pass
 * has left the PC. The spooler drops a job once its data is sent, a moment
 * before the last sheet lands, hence the short settle after. Never hangs: a
 * stuck queue times out, and if Get-PrintJob can't run we fall back to a
 * per-page estimate. Same execFile + absolute powershell.exe path as
 * discovery.ts.
 */

const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const POLL_MS = 2_000;
const FIRST_POLL_MS = 3_000;
const SETTLE_MS = 5_000;
const MAX_WAIT_MS = 15 * 60 * 1000;
const FALLBACK_MS_PER_PAGE = 3_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function queuedJobs(printerName: string): Promise<number> {
  const name = printerName.replace(/'/g, "''");
  const script = `@(Get-PrintJob -PrinterName '${name}' -ErrorAction Stop).Count`;
  return new Promise((resolve, reject) => {
    execFile(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 15_000, windowsHide: true }, (err, stdout) => {
      const count = Number.parseInt(String(stdout).trim(), 10);
      if (err || Number.isNaN(count)) reject(err ?? new Error(`Unexpected Get-PrintJob output "${stdout}"`));
      else resolve(count);
    });
  });
}

export async function waitForPrinterIdle(printerName: string, pages: number): Promise<void> {
  const deadline = Date.now() + Math.min(60_000 + 6_000 * pages, MAX_WAIT_MS);
  await sleep(FIRST_POLL_MS);
  for (;;) {
    let count: number;
    try {
      count = await queuedJobs(printerName);
    } catch (err) {
      log.warn(`[spool] can't read the queue for ${printerName}, waiting by page count`, err instanceof Error ? err.message : err);
      await sleep(FALLBACK_MS_PER_PAGE * pages);
      return;
    }
    if (count === 0) break;
    if (Date.now() > deadline) {
      log.warn(`[spool] ${printerName} still has ${count} job(s) queued; carrying on`);
      return;
    }
    await sleep(POLL_MS);
  }
  await sleep(SETTLE_MS);
}
