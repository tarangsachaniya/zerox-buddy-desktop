import { app, BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { PDFDocument, StandardFonts } from "pdf-lib";

import type { Bootstrap, DeviceQueue, ManualDuplexAnswer, ManualDuplexPrompt, NeedsCheck, PrintTicketOptions, QueueJob, ServerPrinter } from "../../shared/types";
import { ApiError, deviceRequest } from "../auth/api-client";
import { getSession } from "../auth/token-store";
import { log } from "../log";
import { getState, setLocal, update } from "../state";
import { wsEvents } from "../ws/ws-client";
import { detectPrinters } from "./discovery";
import { forget, lookup, recordPhase } from "./ledger";
import { buildPrintPdf, isThermal, paperMm } from "./layout";
import type { LayoutSource } from "./layout";
import { splitManualDuplex } from "./manual-duplex";
import { normaliseRanges, sumatraKnowsPaper, sumatraSettings } from "./print-settings";
import { applyPrintTicket, isEmptyTicket } from "./print-ticket";
import type { AppliedTicket } from "./print-ticket";
import { canPrint, routeJob } from "./router";
import { snapshotQueue, waitForPrintComplete } from "./spool-wait";
import type { WaitOutcome } from "./spool-wait";
import { openInViewer, printWithSumatra, sumatraAvailable } from "./sumatra";

/**
 * Zerox Buddy Desktop's job loop.
 *
 *   sync      queue on every WS frame and every 20 s; printers + shop settings every 60 s
 *   auto      Print automatically + Choose printer automatically + no preview:
 *             route → claim → download → print → report, per-printer serial
 *   manual    otherwise the Queue screen's Print / Preview buttons do the same
 *   done      a pass is done when its paper is out (spool-wait.ts), not when
 *             the spooler took it; two-sided jobs also wait for the operator
 *             to confirm every sheet is out
 *   recover   on start, jobs this computer held are settled from the ledger —
 *             never re-sent on a guess
 *
 * Downloads live in userData/jobs/<jobId> and are deleted as soon as the job
 * is done or failed, whatever happens.
 */

const QUEUE_POLL_MS = 20_000;
const PRINTER_SYNC_MS = 60_000;

type Attempt = { attemptId: string; printer: ServerPrinter; dir: string; files: string[] };

let running = false;
let queueTimer: NodeJS.Timeout | null = null;
let printerTimer: NodeJS.Timeout | null = null;
let refreshing: Promise<void> | null = null;
let recovered = false;

/** Jobs this computer is working on right now (jobId → printerId). */
const inFlight = new Map<string, string>();
/** One job at a time per printer, in arrival order. */
const printerChains = new Map<string, Promise<void>>();
/** Claimed and downloaded, waiting for the person at the counter to confirm. */
const previewing = new Map<string, Attempt>();

function jobsDir(jobId: string): string {
  return join(app.getPath("userData"), "jobs", jobId);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong";
}

// ─── sync ────────────────────────────────────────────────────────────────────

export async function syncPrinters(): Promise<void> {
  try {
    const detected = await detectPrinters();
    const { printers } = await deviceRequest<{ printers: ServerPrinter[] }>("/printers", { method: "PUT", body: { printers: detected } });
    update({ printers });
  } catch (err) {
    log.warn("[sync] printers", message(err));
    if (err instanceof ApiError && err.status === 401) return signedOutElsewhere("syncPrinters", message(err));
  }
}

async function syncBootstrap(): Promise<void> {
  const boot = await deviceRequest<Bootstrap>("/bootstrap");
  update({
    shop: boot.shop,
    entitlements: boot.entitlements,
    printers: boot.printers,
    paperSizeCatalog: boot.paperSizeCatalog,
    passportPresets: boot.passportPresets ?? [],
  });
}

export function refreshQueue(): Promise<void> {
  if (refreshing) return refreshing;
  // Released in .finally() so it's cleared after the assignment, never before it.
  refreshing = (async () => {
    try {
      const queue = await deviceRequest<DeviceQueue>("/jobs/queue");
      update({ queue, lastSyncAt: new Date().toISOString(), error: null });
      if (!recovered) {
        recovered = true;
        await recoverInterrupted(queue);
      }
      schedule();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return signedOutElsewhere("refreshQueue", message(err));
      update({ error: err instanceof ApiError && err.status === 0 ? err.message : `Couldn't refresh: ${message(err)}` });
    }
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

let onSignedOut: () => void = () => {};
export function setSignedOutHandler(handler: () => void): void {
  onSignedOut = handler;
}
/**
 * Fires only after deviceRequest's own retry-once-then-clear logic already
 * confirmed two consecutive genuine 401s (never a 5xx/timeout/429 — see its
 * own comment). `source` + `detail` name exactly which call and what the
 * server said, so a report of "I got signed out" has a concrete log line to
 * point at instead of a guess.
 */
function signedOutElsewhere(source: string, detail: string): void {
  log.info(`[auth] session ended by the server (${source}): ${detail}`);
  onSignedOut();
}

// ─── automatic printing ──────────────────────────────────────────────────────

function autoMode(): boolean {
  const shop = getState().shop;
  return !!shop && shop.autoPrint && shop.autoRouting && !shop.requirePreview;
}

function loadByPrinter(): Record<string, number> {
  const load: Record<string, number> = {};
  for (const printerId of inFlight.values()) load[printerId] = (load[printerId] ?? 0) + 1;
  return load;
}

/** Decide what can run now; record why the rest can't. */
function schedule(): void {
  const { queue, printers } = getState();
  const blocked: Record<string, string> = {};
  if (!sumatraAvailable()) {
    for (const job of queue.waiting) blocked[job.id] = "Printing engine missing. Reinstall Zerox Buddy Desktop.";
    update({ blocked });
    return;
  }

  for (const job of queue.waiting) {
    if (inFlight.has(job.id) || previewing.has(job.id)) continue;
    const route = routeJob(job, printers, loadByPrinter());
    if (!route.ok) {
      blocked[job.id] = route.reason;
      continue;
    }
    if (autoMode()) enqueue(job, route.printer);
  }
  update({ blocked });
}

function enqueue(job: QueueJob, printer: ServerPrinter, opts: { attempt?: Attempt } = {}): void {
  if (inFlight.has(job.id)) return;
  inFlight.set(job.id, printer.id);
  setLocal(job.id, { jobId: job.id, phase: "claiming", printerName: printer.displayName });
  const previous = printerChains.get(printer.id) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => runJob(job, printer, opts.attempt))
    .finally(() => {
      inFlight.delete(job.id);
      if (printerChains.get(printer.id) === next) printerChains.delete(printer.id);
      void refreshQueue();
    });
  printerChains.set(printer.id, next);
}

async function report(attemptId: string, status: "DOWNLOADING" | "PRINTING" | "COMPLETED" | "FAILED", extra: { error?: string; pagesSent?: boolean } = {}) {
  return deviceRequest<{ jobStatus: string; stop?: boolean }>(`/attempts/${attemptId}/status`, {
    method: "POST",
    body: { status, ...extra },
  });
}

async function claimAndDownload(job: QueueJob, printer: ServerPrinter): Promise<Attempt | null> {
  const attemptId = randomUUID();
  try {
    await deviceRequest(`/jobs/${job.id}/claim`, { method: "POST", body: { attemptId, printerId: printer.id } });
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      log.info(`[job] ${job.id} taken by another computer`);
      setLocal(job.id, null);
      return null;
    }
    throw err;
  }

  const dir = jobsDir(job.id);
  const attempt: Attempt = { attemptId, printer, dir, files: [] };
  try {
    setLocal(job.id, { jobId: job.id, phase: "downloading", printerName: printer.displayName });
    const r = await report(attemptId, "DOWNLOADING");
    if (r.stop) throw new StopError(r.jobStatus);
    await mkdir(dir, { recursive: true });
    for (const [i, f] of job.files.entries()) {
      const link = await deviceRequest<{ url: string }>(`/jobs/${job.id}/files/${f.id}/url`, { method: "POST" });
      const res = await fetch(link.url);
      if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
      const ext = f.mimeType === "application/pdf" ? "pdf" : f.mimeType === "image/png" ? "png" : "jpg";
      const path = join(dir, `${String(i + 1).padStart(2, "0")}.${ext}`);
      await writeFile(path, Buffer.from(await res.arrayBuffer()));
      attempt.files.push(path);
    }
    return attempt;
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    if (err instanceof StopError) {
      setLocal(job.id, null);
      return null;
    }
    // Nothing reached a printer: the server puts the job back in the queue.
    await report(attemptId, "FAILED", { error: message(err), pagesSent: false }).catch(() => {});
    throw err;
  }
}

class StopError extends Error {
  constructor(readonly jobStatus: string) {
    super(jobStatus === "CANCELLED" ? "Cancelled by the shop" : "No longer assigned to this computer");
  }
}

async function runJob(job: QueueJob, printer: ServerPrinter, prepared?: Attempt): Promise<void> {
  let attempt: Attempt | null = prepared ?? null;
  let handedOff = false;
  try {
    attempt ??= await claimAndDownload(job, printer);
    if (!attempt) return;

    setLocal(job.id, { jobId: job.id, phase: "printing", printerName: printer.displayName });
    const r = await report(attempt.attemptId, "PRINTING");
    if (r.stop) throw new StopError(r.jobStatus);

    recordPhase(attempt.attemptId, { jobId: job.id, printerId: printer.id, phase: "printing" });
    let sheets = job.totalPages * job.copies;
    let outcome: WaitOutcome;
    if (isThermal(job.paperSize)) {
      // Continuous rolls have no page shape to lay out: print each file as-is.
      const before = await snapshotQueue(printer.systemName);
      for (const [i, path] of attempt.files.entries()) {
        const file = job.files[i]!;
        const settings = sumatraSettings({
          pageRanges: file.pageRanges,
          copies: job.copies,
          duplex: job.duplex,
          printType: job.printType,
          paperSize: job.paperSize,
          orientation: "PORTRAIT",
          isImage: file.mimeType !== "application/pdf",
        });
        handedOff = true;
        await printWithSumatra(path, printer.systemName, settings);
      }
      recordPhase(attempt.attemptId, { jobId: job.id, printerId: printer.id, phase: "sent" });
      outcome = await waitForPaper(job.id, printer, sheets, before, "Waiting for the printer to finish");
    } else {
      const manual = job.duplex && !printer.supportsDuplex && printer.manualDuplex;
      // One print-ready PDF for the whole job: orientation, scale, margins,
      // bleed and pages-per-sheet are applied here, not left to the driver.
      const sources: LayoutSource[] = [];
      for (const [i, path] of attempt.files.entries()) {
        const file = job.files[i]!;
        sources.push({
          bytes: await readFile(path),
          isImage: file.mimeType !== "application/pdf",
          mimeType: file.mimeType,
          pageRanges: normaliseRanges(file.pageRanges),
        });
      }
      const laid = await buildPrintPdf(sources, {
        paperSize: job.paperSize,
        orientation: job.orientation,
        scaleMode: job.scaleMode,
        margins: job.margins,
        bleedMm: job.bleedMm,
        pagesPerSheet: job.pagesPerSheet,
      });
      if (manual) {
        await printManualDuplex({
          printer,
          dir: attempt.dir,
          sheets: laid.bytes,
          job,
          onHandoff: () => {
            handedOff = true;
          },
          onSent: () => recordPhase(attempt!.attemptId, { jobId: job.id, printerId: printer.id, phase: "sent" }),
        });
        await report(attempt.attemptId, "COMPLETED");
        forget(attempt.attemptId);
        log.info(`[job] #${job.specimenNo} printed (by hand, both sides) on ${printer.displayName}`);
        setLocal(job.id, { jobId: job.id, phase: "done", printerName: printer.displayName });
        notify(`#${job.specimenNo} printed`, `${job.totalPages * job.copies} pages on ${printer.displayName}`);
        return;
      }
      sheets = laid.sheets * job.copies;
      const laidPath = join(attempt.dir, "print.pdf");
      await writeFile(laidPath, laid.bytes);
      const settings = sumatraSettings({
        pageRanges: null,
        copies: job.copies,
        duplex: job.duplex,
        duplexFlip: job.duplexFlip,
        printType: job.printType,
        paperSize: job.paperSize,
        orientation: job.orientation,
        isImage: false,
        prelaid: true,
      });
      handedOff = true;
      const send = async () => {
        const before = await snapshotQueue(printer.systemName);
        await printWithSumatra(laidPath, printer.systemName, settings);
        recordPhase(attempt!.attemptId, { jobId: job.id, printerId: printer.id, phase: "sent" });
        return waitForPaper(job.id, printer, sheets, before, "Waiting for the printer to finish");
      };
      outcome = await send();
      // Two-sided on the printer itself: a person confirms every sheet is out.
      while (job.duplex && (await confirmAllOut(job, printer, sheets, false, outcome)) === "reprint") outcome = await send();
    }
    if (outcome === "uncertain") log.info(`[job] #${job.specimenNo}: couldn't confirm the printer finished, reported after the speed wait`);
    await report(attempt.attemptId, "COMPLETED");
    forget(attempt.attemptId);
    log.info(`[job] #${job.specimenNo} printed on ${printer.displayName}`);
    setLocal(job.id, { jobId: job.id, phase: "done", printerName: printer.displayName });
    notify(`#${job.specimenNo} printed`, `${job.totalPages * job.copies} pages on ${printer.displayName}`);
  } catch (err) {
    if (err instanceof StopError) {
      setLocal(job.id, { jobId: job.id, phase: "failed", message: err.message });
    } else {
      log.warn(`[job] ${job.id} failed`, message(err));
      if (attempt) {
        // After the first hand-off, pages may be on the tray: a person decides.
        await report(attempt.attemptId, "FAILED", { error: message(err), pagesSent: handedOff }).catch(() => {});
        if (!handedOff) forget(attempt.attemptId);
      }
      setLocal(job.id, { jobId: job.id, phase: "failed", printerName: printer.displayName, message: message(err) });
    }
  } finally {
    if (attempt) await rm(attempt.dir, { recursive: true, force: true }).catch(() => {});
    setTimeout(() => setLocal(job.id, null), 15_000);
  }
}

// ─── manual double-sided ─────────────────────────────────────────────────────

/**
 * Prompts waiting for the operator, oldest first. Two printers can each be
 * waiting on a person at once; the dialog shows one at a time and every
 * answer goes to the job it was asked for.
 */
const prompts: { prompt: ManualDuplexPrompt; resolve: (answer: ManualDuplexAnswer) => void }[] = [];

function askOperator(prompt: ManualDuplexPrompt): Promise<ManualDuplexAnswer> {
  return new Promise((resolve) => {
    prompts.push({ prompt, resolve });
    if (prompts.length === 1) update({ manualDuplexPrompt: prompt });
  });
}

/** The operator's button press in the two-sided dialog. */
export function answerManualDuplex(answer: ManualDuplexAnswer): void {
  const current = prompts.shift();
  if (!current) return;
  update({ manualDuplexPrompt: prompts[0]?.prompt ?? null });
  current.resolve(answer);
}

/** Waits for a pass's paper to come out, showing printer problems (jam, no paper) on the job meanwhile. */
function waitForPaper(jobId: string, printer: ServerPrinter, sheets: number, before: number[] | null, label: string): Promise<WaitOutcome> {
  const show = (problem: string | null) =>
    setLocal(jobId, { jobId, phase: "printing", printerName: printer.displayName, message: problem ? `${problem}. Fix it at the printer` : label });
  show(null);
  return waitForPrintComplete({ printerName: printer.systemName, sheets, pagesPerMinute: printer.pagesPerMinute, before, onProblem: show });
}

/**
 * After the last pass of a two-sided job: only a person can see that every
 * sheet is out. "problem" throws, so the job is reported failed with pages
 * possibly on paper; "reprint" is left to the caller, which knows which pass
 * to send again.
 */
async function confirmAllOut(job: ManualDuplexJob, printer: ServerPrinter, sheets: number, byHand: boolean, outcome: WaitOutcome): Promise<"done" | "reprint"> {
  setLocal(job.id, { jobId: job.id, phase: "printing", printerName: printer.displayName, message: "Waiting for you to check every page is out" });
  const answer = await askOperator({
    stage: "confirmDone",
    jobId: job.id,
    specimenNo: job.specimenNo,
    printerName: printer.displayName,
    uncertain: outcome === "uncertain",
    sheets,
    byHand,
  });
  if (answer === "problem") throw new Error("Marked as a problem at the counter. Check the printed pages before printing again.");
  return answer === "reprint" ? "reprint" : "done";
}

type ManualDuplexJob = Pick<QueueJob, "id" | "specimenNo" | "copies" | "duplexFlip" | "printType" | "paperSize" | "orientation">;

/**
 * Front sheets, then the operator flips the stack, then back sheets, then
 * the operator confirms they're all out. The
 * printer's chain is held for the whole time, so no other job slips onto the
 * paper in between. Cancelling throws after the front pass reached the tray,
 * which the caller reports as "pages may be on paper" for a person to settle.
 */
async function printManualDuplex(args: {
  printer: ServerPrinter;
  dir: string;
  sheets: Uint8Array;
  job: ManualDuplexJob;
  onHandoff: () => void;
  /** Every page has been handed to the spooler at least once. */
  onSent?: () => void;
}): Promise<void> {
  const { printer, dir, job } = args;
  const split = await splitManualDuplex(args.sheets, job.copies, printer.manualDuplexEvenOrder, job.duplexFlip, printer.manualDuplexFirst);
  const frontPath = join(dir, "front.pdf");
  const backPath = join(dir, "back.pdf");
  await writeFile(frontPath, split.front);
  await writeFile(backPath, split.back);

  const settings = sumatraSettings({
    pageRanges: null,
    copies: 1,
    duplex: false,
    printType: job.printType,
    paperSize: job.paperSize,
    orientation: job.orientation,
    isImage: false,
    prelaid: true,
  });

  const firstSide = printer.manualDuplexFirst === "ODD" ? "odd" : "even";
  const secondSide = firstSide === "odd" ? "even" : "odd";
  // The flip prompt waits for the front sheets to be out of the printer, not
  // just accepted by the spooler.
  const sendPass = async (path: string, sheets: number, label: string) => {
    const before = await snapshotQueue(printer.systemName);
    await printWithSumatra(path, printer.systemName, settings);
    return waitForPaper(job.id, printer, sheets, before, label);
  };
  const sendFront = () => {
    args.onHandoff();
    return sendPass(frontPath, split.frontSheets, `Printing the ${firstSide} pages (${split.frontSheets} sheets)`);
  };
  let outcome = await sendFront();

  for (;;) {
    setLocal(job.id, { jobId: job.id, phase: "printing", printerName: printer.displayName, message: "Waiting for you to turn the paper over" });
    const answer = await askOperator({
      stage: "flip",
      uncertain: outcome === "uncertain",
      jobId: job.id,
      specimenNo: job.specimenNo,
      printerName: printer.displayName,
      flip: job.duplexFlip,
      evenOrder: printer.manualDuplexEvenOrder,
      first: printer.manualDuplexFirst,
      note: printer.manualDuplexNote,
      frontSheets: split.frontSheets,
      backSheets: split.backSheets,
      oddCount: split.padded,
    });
    if (answer === "cancel") throw new Error("Stopped before the back sides. The front sides are already on paper.");
    if (answer === "reprintFront") {
      outcome = await sendFront();
      continue;
    }
    break;
  }
  const sendBack = () => sendPass(backPath, split.backSheets, `Printing the ${secondSide} pages (${split.backSheets} sheets)`);
  outcome = await sendBack();
  args.onSent?.();
  while ((await confirmAllOut(job, printer, split.backSheets, true, outcome)) === "reprint") outcome = await sendBack();
}

/** Prints a 3-page sample both sides, so the owner can check the flip and order settings. */
export async function printTestDuplex(printerId: string): Promise<void> {
  const printer = getState().printers.find((p) => p.id === printerId);
  if (!printer) throw new Error("Printer not found");
  if (!printer.manualDuplex || printer.supportsDuplex) throw new Error("Turn on manual double-sided for this printer first");
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const size = paperMm(printer.paperSizes[0] ?? "A4").map((mm) => (mm * 72) / 25.4) as [number, number];
  for (let i = 1; i <= 3; i++) {
    const page = doc.addPage(size);
    page.drawText(`Page ${i}`, { x: 60, y: size[1] - 140, size: 64, font });
    page.drawText(i % 2 === 1 ? "Odd page" : "Even page", { x: 60, y: size[1] - 190, size: 24, font });
    page.drawText("Zerox Buddy double-sided test. Top of the page is up.", { x: 60, y: 60, size: 12, font });
  }
  const dir = join(app.getPath("userData"), "jobs", "test-duplex");
  await mkdir(dir, { recursive: true });
  try {
    await printManualDuplex({
      printer,
      dir,
      sheets: await doc.save(),
      job: {
        id: "test-duplex",
        specimenNo: null,
        copies: 1,
        duplexFlip: "LONG",
        printType: "BW",
        paperSize: printer.paperSizes[0] ?? "A4",
        orientation: "PORTRAIT",
      },
      onHandoff: () => {},
    });
  } finally {
    setLocal("test-duplex", null);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ─── counter prints (photocopies, passport photos) ───────────────────────────

/** Runs `work` on the printer's chain: after whatever it's printing now, before anything queued later. */
function onPrinterChain<T>(printer: ServerPrinter, work: () => Promise<T>): Promise<T> {
  const previous = printerChains.get(printer.id) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(work);
  const settled = next.then(
    () => {},
    () => {},
  );
  printerChains.set(printer.id, settled);
  void settled.finally(() => {
    if (printerChains.get(printer.id) === settled) printerChains.delete(printer.id);
  });
  return next;
}

/**
 * Sets the operator's paper type / quality / DPI for this print only and puts
 * the printer back afterwards — inside the chain, so no customer job ever
 * prints with them. Windows refusing them doesn't stop the print.
 */
async function withTicket<T>(
  id: string,
  printer: ServerPrinter,
  ticket: PrintTicketOptions | null | undefined,
  label: string,
  work: (note: string, applied: AppliedTicket | null) => Promise<T>,
): Promise<T> {
  if (isEmptyTicket(ticket)) return work(label, null);
  setLocal(id, { jobId: id, phase: "printing", printerName: printer.displayName, message: "Setting up the printer" });
  const applied = await applyPrintTicket(printer.systemName, ticket);
  const note = applied?.summary ? `${label} (${applied.summary})` : label;
  try {
    return await work(note, applied);
  } finally {
    await applied?.restore();
  }
}

/**
 * Prints a photocopy made at the counter: same per-printer queue (so it never
 * lands in the middle of a customer's job), same layout, same wait for the
 * paper and, when two-sided, the same flip and "all pages out?" prompts.
 * Resolves once the copy is out; throws if it failed or was stopped.
 */
export function printLocalCopy(args: {
  printer: ServerPrinter;
  pdf: Uint8Array;
  copies: number;
  duplex: boolean;
  printType: QueueJob["printType"];
  paperSize: QueueJob["paperSize"];
  ticket?: PrintTicketOptions | null;
}): Promise<void> {
  const { printer } = args;
  const id = `copy-${randomUUID()}`;
  return onPrinterChain(printer, async () => {
    const dir = jobsDir(id);
    await mkdir(dir, { recursive: true });
    try {
      setLocal(id, { jobId: id, phase: "printing", printerName: printer.displayName, message: "Photocopy" });
      const laid = await buildPrintPdf([{ bytes: args.pdf, isImage: false, mimeType: "application/pdf", pageRanges: null }], {
        paperSize: args.paperSize,
        orientation: "AUTO",
        scaleMode: "FIT",
        margins: "NONE",
        bleedMm: 0,
        pagesPerSheet: 1,
      });
      const job: ManualDuplexJob = {
        id,
        specimenNo: null,
        copies: args.copies,
        duplexFlip: "LONG",
        printType: args.printType,
        paperSize: args.paperSize,
        orientation: "PORTRAIT",
      };
      await withTicket(id, printer, args.ticket, "Printing the photocopy", async (note) => {
        if (args.duplex && !printer.supportsDuplex) {
          if (!printer.manualDuplex) throw new Error(`${printer.displayName} can't print double-sided`);
          await printManualDuplex({ printer, dir, sheets: laid.bytes, job, onHandoff: () => {} });
          return;
        }
        const path = join(dir, "copy.pdf");
        await writeFile(path, laid.bytes);
        const settings = sumatraSettings({
          pageRanges: null,
          copies: args.copies,
          duplex: args.duplex,
          duplexFlip: "LONG",
          printType: args.printType,
          paperSize: args.paperSize,
          orientation: "PORTRAIT",
          isImage: false,
          prelaid: true,
        });
        const sheets = laid.sheets * args.copies;
        const send = async () => {
          const before = await snapshotQueue(printer.systemName);
          await printWithSumatra(path, printer.systemName, settings);
          return waitForPaper(id, printer, sheets, before, note);
        };
        let outcome = await send();
        while (args.duplex && (await confirmAllOut(job, printer, sheets, false, outcome)) === "reprint") outcome = await send();
      });
    } finally {
      setLocal(id, null);
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
}

/**
 * Prints a sheet that must come out at exactly 100% (passport photos): the
 * PDF goes to the printer as it is — no re-layout, no fit-to-page — on the
 * same per-printer queue as everything else. Resolves with "done" once the
 * paper is out, or "uncertain" when Windows couldn't tell; throws if the
 * print couldn't be sent.
 */
export function printPrelaidExact(args: {
  printer: ServerPrinter;
  pdf: Uint8Array;
  /** Sheets in the PDF. */
  sheets: number;
  copies: number;
  printType: QueueJob["printType"];
  paperSize: QueueJob["paperSize"];
  label: string;
  ticket?: PrintTicketOptions | null;
  /** The sheet's paper, portrait, for printers SumatraPDF can't name it to. */
  paperMm: { widthMm: number; heightMm: number };
}): Promise<WaitOutcome> {
  const { printer } = args;
  const id = `photo-${randomUUID()}`;
  return onPrinterChain(printer, async () => {
    const dir = jobsDir(id);
    await mkdir(dir, { recursive: true });
    try {
      setLocal(id, { jobId: id, phase: "printing", printerName: printer.displayName, message: args.label });
      const path = join(dir, "sheet.pdf");
      await writeFile(path, args.pdf);
      const known = sumatraKnowsPaper(args.paperSize);
      const ticket = known ? args.ticket : { ...args.ticket, paper: args.paperMm };
      return await withTicket(id, printer, ticket, args.label, async (note, applied) => {
        // SumatraPDF picks its own paper (Letter) unless told one it can find on the printer by name.
        if (!known && !applied?.paperName) throw new Error(`${printer.displayName} has no ${args.paperSize === "4X6" ? "4 × 6 in" : args.paperSize} paper size. Add it in the printer's preferences, or print on A4`);
        const settings = sumatraSettings({
          pageRanges: null,
          copies: args.copies,
          duplex: false,
          printType: args.printType,
          paperSize: args.paperSize,
          orientation: "PORTRAIT",
          isImage: false,
          prelaid: true,
          exact: true,
          driverPaper: applied?.paperName ?? null,
        });
        const before = await snapshotQueue(printer.systemName);
        await printWithSumatra(path, printer.systemName, settings);
        return waitForPaper(id, printer, args.sheets * args.copies, before, note);
      });
    } finally {
      setLocal(id, null);
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
}

// ─── recovery after a crash / restart ────────────────────────────────────────

async function recoverInterrupted(queue: DeviceQueue): Promise<void> {
  const deviceId = getSession()?.deviceId;
  for (const job of queue.active) {
    const attempt = job.lastAttempt;
    if (!attempt || attempt.deviceId !== deviceId || inFlight.has(job.id) || previewing.has(job.id)) continue;
    const entry = lookup(attempt.id);
    try {
      if (entry) {
        // Pages may be on the tray, or still to come: only a person can tell.
        // The job stays PRINTING (the customer sees it in progress) until they answer.
        const check: NeedsCheck = { jobId: job.id, attemptId: attempt.id, specimenNo: job.specimenNo };
        update({ needsCheck: { ...getState().needsCheck, [job.id]: check } });
        log.info(`[recover] ${job.id} was ${entry.phase} when Zerox Buddy closed; asking the counter`);
      } else {
        await report(attempt.id, "FAILED", { error: "Zerox Buddy restarted before printing", pagesSent: false });
        log.info(`[recover] ${job.id} settled (not started)`);
      }
    } catch (err) {
      log.warn(`[recover] ${job.id}`, message(err));
    }
    await rm(jobsDir(job.id), { recursive: true, force: true }).catch(() => {});
  }
}

/** "Check the tray" answered: every page came out. */
export async function confirmPrinted(jobId: string): Promise<void> {
  const check = takeCheck(jobId);
  await report(check.attemptId, "COMPLETED");
  forget(check.attemptId);
  await refreshQueue();
}

/** "Check the tray" answered: it didn't all come out, so send the job to print again. */
export async function reprintChecked(jobId: string): Promise<void> {
  const check = takeCheck(jobId);
  await report(check.attemptId, "FAILED", { error: "Didn't finish when Zerox Buddy closed. Printing again.", pagesSent: true });
  forget(check.attemptId);
  await retryFailed(jobId);
}

function takeCheck(jobId: string): NeedsCheck {
  const { [jobId]: check, ...rest } = getState().needsCheck;
  if (!check) throw new Error("This request was already settled");
  update({ needsCheck: rest });
  return check;
}

// ─── manual actions (Queue screen) ───────────────────────────────────────────

function findWaiting(jobId: string): QueueJob {
  const job = getState().queue.waiting.find((j) => j.id === jobId);
  if (!job) throw new Error("This request is no longer waiting. It may have been printed or cancelled.");
  return job;
}

function findPrinter(printerId: string): ServerPrinter {
  const printer = getState().printers.find((p) => p.id === printerId);
  if (!printer) throw new Error("Printer not found");
  if (!printer.isEnabled) throw new Error(`${printer.displayName} is turned off in Zerox Buddy`);
  return printer;
}

export async function printNow(jobId: string, printerId: string): Promise<void> {
  const pending = previewing.get(jobId);
  if (pending) {
    previewing.delete(jobId);
    const job = getState().queue.active.find((j) => j.id === jobId);
    if (!job) throw new Error("This request is no longer assigned to this computer");
    enqueue(job, pending.printer, { attempt: pending });
    return;
  }
  const job = findWaiting(jobId);
  const printer = findPrinter(printerId);
  if (!canPrint(printer, job)) throw new Error(`${printer.displayName} can't print this request`);
  enqueue(job, printer);
}

export async function preview(jobId: string, printerId: string): Promise<void> {
  const existing = previewing.get(jobId);
  if (existing) {
    for (const f of existing.files) openInViewer(f);
    return;
  }
  const job = findWaiting(jobId);
  const printer = findPrinter(printerId);
  if (!canPrint(printer, job)) throw new Error(`${printer.displayName} can't print this request`);
  inFlight.set(jobId, printer.id);
  try {
    const attempt = await claimAndDownload(job, printer);
    if (!attempt) return;
    previewing.set(jobId, attempt);
    setLocal(jobId, { jobId, phase: "downloading", printerName: printer.displayName, message: "Previewing" });
    for (const f of attempt.files) openInViewer(f);
  } finally {
    inFlight.delete(jobId);
    void refreshQueue();
  }
}

/** Preview declined: back to the queue, nothing printed. */
export async function putBack(jobId: string): Promise<void> {
  const attempt = previewing.get(jobId);
  if (!attempt) return;
  previewing.delete(jobId);
  await report(attempt.attemptId, "FAILED", { error: "Put back after preview", pagesSent: false }).catch(() => {});
  await rm(attempt.dir, { recursive: true, force: true }).catch(() => {});
  setLocal(jobId, null);
  void refreshQueue();
}

export async function retryFailed(jobId: string): Promise<void> {
  await deviceRequest(`/jobs/${jobId}/retry`, { method: "POST" });
  await refreshQueue();
}

export async function deleteJob(jobId: string): Promise<void> {
  await deviceRequest(`/jobs/${jobId}`, { method: "DELETE" });
  await refreshQueue();
}

export async function updatePrinter(printerId: string, patch: Record<string, unknown>): Promise<void> {
  const { printer } = await deviceRequest<{ printer: ServerPrinter }>(`/printers/${printerId}`, { method: "PATCH", body: patch });
  update({ printers: getState().printers.map((p) => (p.id === printer.id ? { ...p, ...printer } : p)) });
  schedule();
}

/**
 * In-app editing of the shop's print settings (auto-print, routing, preview,
 * delete-after-print, default copies) — the only shop fields Zerox Buddy
 * Desktop is allowed to change; see zeroxDevicePrintSettingsSchema on the
 * server. Applies the fresh bootstrap immediately so Settings and the queue
 * (autoMode()) pick it up without waiting for the next 60s sync.
 */
export async function updatePrintSettings(patch: Record<string, unknown>): Promise<void> {
  const bootstrap = await deviceRequest<Bootstrap>("/print-settings", { method: "PATCH", body: patch });
  update({
    shop: bootstrap.shop,
    entitlements: bootstrap.entitlements,
    printers: bootstrap.printers,
    paperSizeCatalog: bootstrap.paperSizeCatalog,
    passportPresets: bootstrap.passportPresets ?? [],
  });
  schedule();
}

// ─── test page ───────────────────────────────────────────────────────────────

export async function printTestPage(printerId: string): Promise<void> {
  const printer = getState().printers.find((p) => p.id === printerId);
  if (!printer) throw new Error("Printer not found");
  const shop = getState().shop;
  const html = `<!doctype html><meta charset="utf-8"><body style="font-family:Segoe UI,Arial;padding:48px;color:#111c16">
    <h1 style="font-size:40px;margin:0">Zerox Buddy test page</h1>
    <p style="font-size:18px">${escapeHtml(shop?.shopName ?? "")} · ${escapeHtml(printer.displayName)}</p>
    <p style="font-size:14px;color:#5a6459">${new Date().toLocaleString("en-IN")}</p>
    <div style="margin-top:32px;display:flex;gap:12px">${["#111c16", "#0e2119", "#dff23c", "#ffe45c", "#d6cdb9"].map((c) => `<div style="width:80px;height:80px;background:${c}"></div>`).join("")}</div>
    <p style="margin-top:32px;font-size:14px">If you can read this, Zerox Buddy can print to this printer.</p></body>`;
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const pdf = await win.webContents.printToPDF({ pageSize: "A4", printBackground: true });
    const dir = join(app.getPath("userData"), "jobs", "test-page");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "test.pdf");
    await writeFile(path, pdf);
    // The rendered content is always A4 (Electron's printToPDF only accepts a
    // fixed page-size list); "fit" in sumatraSettings scales it down to
    // whatever paper is actually requested below. That requested paper MUST
    // be the printer's own assigned size — a thermal roll printer typically
    // has no "A4" in its Windows driver at all, so hardcoding "A4" here (as
    // this used to) silently fails the test page for every non-A4 printer.
    await printWithSumatra(
      path,
      printer.systemName,
      sumatraSettings({
        pageRanges: null,
        copies: 1,
        duplex: false,
        printType: printer.supportsColor ? "COLOR" : "BW",
        paperSize: printer.paperSizes[0] ?? "A4",
        orientation: "PORTRAIT",
        isImage: false,
      }),
    );
    await rm(dir, { recursive: true, force: true });
  } finally {
    win.destroy();
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// ─── notifications ───────────────────────────────────────────────────────────

let notifier: (title: string, body: string) => void = () => {};
export function setNotifier(fn: (title: string, body: string) => void): void {
  notifier = fn;
}
function notify(title: string, body: string): void {
  notifier(title, body);
}

// ─── lifecycle ───────────────────────────────────────────────────────────────

function onWsMessage(): void {
  void refreshQueue();
}

export async function startProcessor(): Promise<void> {
  if (running) return;
  running = true;
  recovered = false;
  wsEvents.on("message", onWsMessage);
  try {
    await syncBootstrap();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return signedOutElsewhere("startProcessor/syncBootstrap", message(err));
    update({ error: message(err) });
  }
  await syncPrinters();
  await refreshQueue();
  queueTimer = setInterval(() => void refreshQueue(), QUEUE_POLL_MS);
  printerTimer = setInterval(() => {
    void syncBootstrap().catch(() => {});
    void syncPrinters();
  }, PRINTER_SYNC_MS);
}

export function stopProcessor(): void {
  running = false;
  wsEvents.off("message", onWsMessage);
  if (queueTimer) clearInterval(queueTimer);
  if (printerTimer) clearInterval(printerTimer);
  queueTimer = printerTimer = null;
  previewing.clear();
}

export function busyCount(): number {
  return inFlight.size;
}
