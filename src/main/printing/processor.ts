import { app, BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Bootstrap, DeviceQueue, QueueJob, ServerPrinter } from "../../shared/types";
import { ApiError, deviceRequest } from "../auth/api-client";
import { getSession } from "../auth/token-store";
import { log } from "../log";
import { getState, setLocal, update } from "../state";
import { wsEvents } from "../ws/ws-client";
import { detectPrinters } from "./discovery";
import { forget, lookup, recordPhase } from "./ledger";
import { buildPrintPdf, isThermal } from "./layout";
import type { LayoutSource } from "./layout";
import { normaliseRanges, sumatraSettings } from "./print-settings";
import { canPrint, routeJob } from "./router";
import { openInViewer, printWithSumatra, sumatraAvailable } from "./sumatra";

/**
 * Zerox Buddy Desktop's job loop.
 *
 *   sync      queue on every WS frame and every 20 s; printers + shop settings every 60 s
 *   auto      Print automatically + Choose printer automatically + no preview:
 *             route → claim → download → print → report, per-printer serial
 *   manual    otherwise the Queue screen's Print / Preview buttons do the same
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
  update({ shop: boot.shop, entitlements: boot.entitlements, printers: boot.printers, paperSizeCatalog: boot.paperSizeCatalog });
}

export function refreshQueue(): Promise<void> {
  refreshing ??= (async () => {
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
    } finally {
      refreshing = null;
    }
  })();
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
    if (isThermal(job.paperSize)) {
      // Continuous rolls have no page shape to lay out: print each file as-is.
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
    } else {
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
        prelaid: { sheetOrientation: laid.uniformOrientation },
      });
      handedOff = true;
      await printWithSumatra(laidPath, printer.systemName, settings);
    }
    recordPhase(attempt.attemptId, { jobId: job.id, printerId: printer.id, phase: "sent" });

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

// ─── recovery after a crash / restart ────────────────────────────────────────

async function recoverInterrupted(queue: DeviceQueue): Promise<void> {
  const deviceId = getSession()?.deviceId;
  for (const job of queue.active) {
    const attempt = job.lastAttempt;
    if (!attempt || attempt.deviceId !== deviceId || inFlight.has(job.id) || previewing.has(job.id)) continue;
    const entry = lookup(attempt.id);
    try {
      if (entry?.phase === "sent") {
        await report(attempt.id, "COMPLETED");
      } else if (entry?.phase === "printing") {
        await report(attempt.id, "FAILED", {
          error: "Zerox Buddy closed while printing. Check the printer tray before printing again.",
          pagesSent: true,
        });
      } else {
        await report(attempt.id, "FAILED", { error: "Zerox Buddy restarted before printing", pagesSent: false });
      }
      forget(attempt.id);
      log.info(`[recover] ${job.id} settled (${entry?.phase ?? "not started"})`);
    } catch (err) {
      log.warn(`[recover] ${job.id}`, message(err));
    }
    await rm(jobsDir(job.id), { recursive: true, force: true }).catch(() => {});
  }
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
