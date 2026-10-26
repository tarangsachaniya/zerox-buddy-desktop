import { execFile } from "node:child_process";

import { log } from "../log";

/**
 * Waits until a pass has physically come out of the printer, so "printed" and
 * the flip-the-paper prompt follow the paper, not the spooler hand-off.
 *
 *   1. our jobs   the Windows jobs Sumatra just added (by id, against a
 *                 snapshot taken before) have left the queue
 *   2. printer    the printer no longer reports Printing / Busy / Warming up
 *                 (or a paper jam etc.), twice in a row
 *   3. floor      never sooner than warm-up + sheets at the printer's speed
 *
 * Step 3 matters most: network and laser printers buffer the whole job in
 * seconds and many drivers never report "Printing", so 1 and 2 can pass
 * while most sheets are still to come. Never hangs: a deadline ends the
 * wait, and a queue that can't be read falls back to the floor alone. Both
 * return "uncertain" so the caller can ask a person. Same execFile +
 * absolute powershell.exe path as discovery.ts.
 */

const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const POLL_MS = 2_000;
const FIRST_POLL_MS = 2_000;
const WARMUP_MS = 15_000;
const MAX_WAIT_MS = 30 * 60 * 1000;
export const DEFAULT_PAGES_PER_MINUTE = 15;

/** MSFT_Printer PrinterStatus codes meaning "not finished": working, or stopped mid-job. */
const WORKING = new Set([9, 10, 11, 14, 15, 16, 17]);
const STOPPED: Record<number, string> = {
  1: "Printer is paused in Windows",
  2: "Printer error",
  4: "Paper jam",
  5: "Out of paper",
  6: "Waiting for manual feed",
  7: "Paper problem",
  12: "Output tray is full",
  19: "Out of toner or ink",
  23: "Printer door is open",
};

export type WaitOutcome = "done" | "uncertain";

export type SpoolDeps = {
  run: (script: string) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

const defaultDeps: SpoolDeps = {
  run: (script) =>
    new Promise((resolve, reject) => {
      execFile(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 15_000, windowsHide: true }, (err, stdout) => {
        if (err) reject(err);
        else resolve(String(stdout));
      });
    }),
  sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

function quote(name: string): string {
  return name.replace(/'/g, "''");
}

async function jobIds(printerName: string, deps: SpoolDeps): Promise<number[]> {
  const out = await deps.run(`@(Get-PrintJob -PrinterName '${quote(printerName)}' -ErrorAction Stop | ForEach-Object { $_.Id }) -join ','`);
  const text = out.trim();
  if (!text) return [];
  const ids = text.split(",").map((s) => Number.parseInt(s, 10));
  if (ids.some(Number.isNaN)) throw new Error(`Unexpected Get-PrintJob output "${text}"`);
  return ids;
}

async function printerStatus(printerName: string, deps: SpoolDeps): Promise<number> {
  const out = await deps.run(`[int](Get-Printer -Name '${quote(printerName)}' -ErrorAction Stop).PrinterStatus`);
  const code = Number.parseInt(out.trim(), 10);
  if (Number.isNaN(code)) throw new Error(`Unexpected Get-Printer output "${out.trim()}"`);
  return code;
}

/** The ids already queued on a printer, taken just before handing it a pass. null when the queue can't be read. */
export async function snapshotQueue(printerName: string, deps: SpoolDeps = defaultDeps): Promise<number[] | null> {
  try {
    return await jobIds(printerName, deps);
  } catch (err) {
    log.warn(`[spool] can't read the queue for ${printerName}`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** Shortest time a pass of this many sheets can take at this speed. */
export function minimumPrintMs(sheets: number, pagesPerMinute: number | null | undefined): number {
  const ppm = pagesPerMinute && pagesPerMinute > 0 ? pagesPerMinute : DEFAULT_PAGES_PER_MINUTE;
  return WARMUP_MS + Math.ceil((Math.max(sheets, 1) * 60_000) / ppm);
}

export async function waitForPrintComplete(
  args: {
    printerName: string;
    sheets: number;
    pagesPerMinute: number | null | undefined;
    /** From snapshotQueue, taken before the pass was sent. */
    before: number[] | null;
    /** Called with what the printer reports while it's stopped mid-job (jam, no paper), or null once it's fine again. */
    onProblem?: (message: string | null) => void;
  },
  deps: SpoolDeps = defaultDeps,
): Promise<WaitOutcome> {
  const { printerName, before } = args;
  const start = deps.now();
  const floor = start + minimumPrintMs(args.sheets, args.pagesPerMinute);
  const deadline = start + Math.min(MAX_WAIT_MS, 3 * (floor - start) + 120_000);
  let uncertain = false;
  let problem: string | null = null;
  const report = (next: string | null) => {
    if (next === problem) return;
    problem = next;
    args.onProblem?.(next);
  };

  await deps.sleep(FIRST_POLL_MS);

  // 1. Our jobs leave the Windows queue.
  for (;;) {
    let ids: number[];
    try {
      ids = await jobIds(printerName, deps);
    } catch (err) {
      log.warn(`[spool] can't read the queue for ${printerName}, waiting by print speed`, err instanceof Error ? err.message : err);
      uncertain = true;
      break;
    }
    const ours = before ? ids.filter((id) => !before.includes(id)) : ids;
    if (ours.length === 0) break;
    if (deps.now() > deadline) {
      log.warn(`[spool] ${printerName} still has ${ours.length} of our job(s) queued; asking a person`);
      uncertain = true;
      break;
    }
    await deps.sleep(POLL_MS);
  }

  // 2. The printer stops reporting work (where its driver reports at all).
  if (!uncertain) {
    let idlePolls = 0;
    for (;;) {
      let code: number;
      try {
        code = await printerStatus(printerName, deps);
      } catch {
        break; // no status from this driver: the floor below still applies
      }
      const stopped = STOPPED[code] ?? null;
      report(stopped);
      idlePolls = WORKING.has(code) || stopped ? 0 : idlePolls + 1;
      if (idlePolls >= 2) break;
      if (deps.now() > deadline) {
        log.warn(`[spool] ${printerName} still reports status ${code}; asking a person`);
        uncertain = true;
        break;
      }
      await deps.sleep(POLL_MS);
    }
  }
  report(null);

  // 3. Never sooner than the paper can physically come out.
  const left = floor - deps.now();
  if (left > 0) await deps.sleep(left);
  return uncertain ? "uncertain" : "done";
}
