import { app, dialog, type BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import type { LocalAttempt, LocalJobStatus, LocalPrintJob, LocalPrintSettings, PickedFile } from "../../shared/types";
import { log } from "../log";
import { normaliseRanges } from "../printing/print-settings";
import { expandRanges } from "../printing/layout";
import type { LayoutSource } from "../printing/layout";
import { printLocalDocument } from "../printing/processor";
import { canPrint } from "../printing/router";
import { recordOrder } from "../scanning/scan-service";
import { getState, update } from "../state";
import { FileRejected, getPick, readChecked, register, releasePick, safeName } from "./files";

/**
 * "Print from PC": files on this computer printed on the shop's printers,
 * with no upload anywhere.
 *
 *   history    userData/local-jobs.json, written before each step, so a crash
 *              or restart never loses a job or what it was doing
 *   evidence   COMPLETED only when the paper is out (spool-wait), UNKNOWN when
 *              Windows can't tell; after a restart mid-print, UNKNOWN too
 *   retry      a new attempt on the same job, after the same warning about
 *              duplicates; the file is re-read and must not have changed
 *   sales      once printed, recorded as a PC_PRINT counter order (priced like
 *              an online print) through the same offline-safe outbox as scans
 *
 * The original files are only read. Paths are kept for a day so "Print
 * again" works, then dropped; temporary copies (none today) are deleted
 * when the job is settled or after a day.
 */

const KEEP_FILES_MS = 24 * 60 * 60 * 1000;
const KEEP_HISTORY_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_HISTORY = 200;

type FileRef = { path: string; size: number; mtimeMs: number; temp: boolean; mimeType: PickedFile["mimeType"]; pages: number; pageRanges: string | null };
type Stored = LocalPrintJob & { shopId: string; fileRefs: FileRef[] | null };

function file(): string {
  return join(app.getPath("userData"), "local-jobs.json");
}

function read(): Stored[] {
  try {
    return JSON.parse(readFileSync(file(), "utf8")) as Stored[];
  } catch {
    return [];
  }
}

function write(entries: Stored[]): void {
  const tmp = `${file()}.tmp`;
  writeFileSync(tmp, JSON.stringify(entries));
  renameSync(tmp, file());
}

function view({ shopId: _s, fileRefs, ...job }: Stored): LocalPrintJob {
  return { ...job, canRetry: !!fileRefs && (job.status === "FAILED" || job.status === "UNKNOWN") };
}

function publish(): void {
  const shopId = getState().shop?.id;
  update({ localJobs: read().filter((j) => j.shopId === shopId).map(view) });
}

function save(job: Stored): void {
  const all = read();
  const i = all.findIndex((j) => j.id === job.id);
  job.updatedAt = new Date().toISOString();
  if (i >= 0) all[i] = job;
  else all.unshift(job);
  write(all);
  publish();
}

function find(jobId: string): Stored {
  const job = read().find((j) => j.id === jobId && j.shopId === getState().shop?.id);
  if (!job) throw new Error("This print isn't in the history any more");
  return job;
}

async function dropTempFiles(refs: FileRef[] | null): Promise<void> {
  for (const r of refs ?? []) if (r.temp) await rm(r.path, { force: true }).catch(() => {});
}

function transition(job: Stored, attempt: LocalAttempt, status: LocalJobStatus, extra: Partial<LocalAttempt> = {}): void {
  const from = job.status;
  Object.assign(attempt, { status, ...extra });
  if (status === "COMPLETED" || status === "FAILED" || status === "UNKNOWN" || status === "CANCELLED") attempt.finishedAt = new Date().toISOString();
  job.status = status;
  job.error = attempt.error;
  save(job);
  log.info(`[local] ${job.id.slice(0, 8)}/${attempt.id.slice(0, 8)} ${from} → ${status}${attempt.evidence ? ` (${attempt.evidence})` : ""}${attempt.error ? `: ${attempt.error}` : ""}`);
}

/** Recorded for sales once it's known to have printed; idempotent on the job id. */
function recordSale(job: Stored, printerId: string): void {
  if (job.orderRef) return;
  job.orderRef = job.id;
  recordOrder({
    clientRef: job.id,
    kind: "PC_PRINT",
    printType: job.settings.printType,
    paperSize: job.settings.paperSize,
    pages: job.pages,
    copies: job.settings.copies,
    duplex: job.settings.duplex,
    idCard: false,
    printerId,
    performedAt: new Date().toISOString(),
  });
}

// ─── picking ─────────────────────────────────────────────────────────────────

/** The Windows file dialog; only what the person chose here can be printed. */
export async function pickFiles(win: BrowserWindow | null): Promise<(PickedFile | { name: string; error: string })[]> {
  const opts: Electron.OpenDialogOptions = {
    title: "Choose files to print",
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "PDF and images", extensions: ["pdf", "jpg", "jpeg", "png"] },
      { name: "All files", extensions: ["*"] },
    ],
  };
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (res.canceled) return [];
  const out = [];
  for (const path of res.filePaths.slice(0, 20)) out.push(await register(path, "local_pc"));
  return out;
}

export async function removePick(pickId: string): Promise<void> {
  const pick = releasePick(String(pickId));
  if (pick?.temp) await rm(pick.path, { force: true }).catch(() => {});
}

// ─── printing ────────────────────────────────────────────────────────────────

const ENUMS = {
  printType: ["BW", "COLOR"],
  duplexFlip: ["LONG", "SHORT"],
  orientation: ["AUTO", "PORTRAIT", "LANDSCAPE"],
  scaleMode: ["FIT", "FILL", "ACTUAL"],
  margins: ["DEFAULT", "NONE", "MINIMUM"],
} as const;

/** The window's settings, checked here: nothing it sends is trusted as is. */
function checkSettings(raw: unknown): LocalPrintSettings {
  const s = (raw ?? {}) as Record<string, unknown>;
  const pick = <K extends keyof typeof ENUMS>(k: K): (typeof ENUMS)[K][number] => {
    const v = s[k];
    if (!(ENUMS[k] as readonly unknown[]).includes(v)) throw new Error(`Invalid ${k}`);
    return v as (typeof ENUMS)[K][number];
  };
  const copies = Number(s.copies);
  if (!Number.isInteger(copies) || copies < 1 || copies > 99) throw new Error("Copies must be 1 to 99");
  if (typeof s.printerId !== "string" || !s.printerId) throw new Error("Choose a printer");
  if (typeof s.paperSize !== "string" || !/^[A-Z0-9_]{1,40}$/.test(s.paperSize)) throw new Error("Choose a paper size");
  const ranges: Record<string, string> = {};
  for (const [k, v] of Object.entries((s.pageRanges ?? {}) as Record<string, unknown>)) if (typeof v === "string" && v.trim()) ranges[k] = v;
  return {
    printerId: s.printerId,
    copies,
    printType: pick("printType"),
    paperSize: s.paperSize,
    duplex: s.duplex === true,
    duplexFlip: pick("duplexFlip"),
    orientation: pick("orientation"),
    scaleMode: pick("scaleMode"),
    margins: pick("margins"),
    pageRanges: ranges,
  };
}

function pagesSelected(ranges: string | null, pages: number): number {
  const n = expandRanges(ranges, pages).length;
  if (n === 0) throw new FileRejected(`No pages in "${ranges}" (the file has ${pages}).`);
  return n;
}

function findPrinter(printerId: string, settings: Pick<LocalPrintSettings, "printType" | "paperSize" | "duplex">) {
  const printer = getState().printers.find((p) => p.id === printerId);
  if (!printer) throw new Error("Choose a printer");
  if (!printer.isEnabled) throw new Error(`${printer.displayName} is turned off in Zerox Buddy`);
  if (!canPrint(printer, settings)) {
    throw new Error(`${printer.displayName} can't print ${settings.printType === "COLOR" ? "in color" : "this"}${settings.duplex ? " double-sided" : ""} on ${settings.paperSize}`);
  }
  return printer;
}

/** Validates everything, saves the job, and starts printing; resolves with the job once it's queued. */
export async function submit(pickIds: unknown, rawSettings: unknown): Promise<LocalPrintJob> {
  const shopId = getState().shop?.id;
  if (!shopId) throw new Error("Sign in first");
  if (!Array.isArray(pickIds) || pickIds.length === 0 || pickIds.length > 20) throw new Error("Choose at least one file");
  const settings = checkSettings(rawSettings);
  findPrinter(settings.printerId, settings);

  const refs: FileRef[] = [];
  const files: LocalPrintJob["files"] = [];
  let pages = 0;
  const source: Stored["source"] = "local_pc";
  for (const id of pickIds) {
    const p = getPick(String(id));
    const ranges = p.mimeType === "application/pdf" ? normaliseRanges(settings.pageRanges[p.pickId] ?? null) : null;
    pages += p.mimeType === "application/pdf" ? pagesSelected(ranges, p.pages) : 1;
    refs.push({ path: p.path, size: p.size, mtimeMs: p.mtimeMs, temp: p.temp, mimeType: p.mimeType, pages: p.pages, pageRanges: ranges });
    files.push({ name: p.name, mimeType: p.mimeType, pages: p.pages, pageRanges: ranges });
  }
  // The job owns the files from here; the picks are spent.
  for (const id of pickIds) releasePick(String(id));

  const now = new Date().toISOString();
  const job: Stored = {
    id: randomUUID(),
    shopId,
    source,
    files,
    settings,
    pages,
    createdAt: now,
    updatedAt: now,
    status: "QUEUED",
    error: null,
    attempts: [],
    canRetry: false,
    orderRef: null,
    fileRefs: refs,
  };
  save(job);
  log.info(`[local] ${job.id.slice(0, 8)} queued: ${files.map((f) => safeName(f.name)).join(", ")} (${pages} pages × ${settings.copies})`);
  void runAttempt(job.id, settings.printerId);
  return view(job);
}

const running = new Set<string>();

async function runAttempt(jobId: string, printerId: string): Promise<void> {
  if (running.has(jobId)) return;
  running.add(jobId);
  const job = find(jobId);
  const printer = getState().printers.find((p) => p.id === printerId);
  const attempt: LocalAttempt = {
    id: randomUUID(),
    printerId,
    printerName: printer?.displayName ?? "Printer",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: "SUBMITTING",
    error: null,
    evidence: null,
    handedOff: false,
  };
  job.attempts.push(attempt);
  transition(job, attempt, "SUBMITTING");
  try {
    const p = findPrinter(printerId, job.settings);
    if (!job.fileRefs) throw new FileRejected("The files are no longer available. Choose them again.");
    const sources: LayoutSource[] = [];
    for (const ref of job.fileRefs) {
      sources.push({ bytes: await readChecked(ref), isImage: ref.mimeType !== "application/pdf", mimeType: ref.mimeType, pageRanges: ref.pageRanges });
    }
    const { outcome } = await printLocalDocument({
      id: `local-${attempt.id}`,
      printer: p,
      sources,
      copies: job.settings.copies,
      duplex: job.settings.duplex,
      duplexFlip: job.settings.duplexFlip,
      printType: job.settings.printType,
      paperSize: job.settings.paperSize,
      orientation: job.settings.orientation,
      scaleMode: job.settings.scaleMode,
      margins: job.settings.margins,
      ticket: { dpi: getState().shop?.printDpi ?? null },
      label: `Printing ${job.files[0]?.name ?? "your file"}`,
      onHandoff: () => {
        if (attempt.handedOff) return;
        // Saved before the spooler gets it: after a crash this says "pages may be out".
        transition(job, attempt, "PRINTING", { handedOff: true });
      },
    });
    if (outcome === "done") {
      transition(job, attempt, "COMPLETED", { evidence: job.settings.duplex ? "operator_confirmed" : "spooler_gone" });
      recordSale(job, p.id);
      save(job);
      await dropTempFiles(job.fileRefs);
      job.fileRefs = null;
      save(job);
    } else {
      transition(job, attempt, "UNKNOWN", { evidence: "spooler_uncertain", error: "Windows couldn't confirm the printer finished. Check the tray." });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Printing failed";
    // Before the hand-off nothing can be on paper; after it, a person decides.
    transition(job, attempt, "FAILED", { error: message, evidence: attempt.handedOff ? "spooler_error" : null });
  } finally {
    running.delete(jobId);
  }
}

/** Print again (FAILED, or UNKNOWN after the warning), as a new attempt on the same job. */
export async function retry(jobId: string, printerId: string, confirmUncertain: boolean): Promise<void> {
  const job = find(String(jobId));
  if (running.has(job.id)) throw new Error("This one is printing already");
  if (job.status !== "FAILED" && job.status !== "UNKNOWN") throw new Error("Only a failed or unconfirmed print can be printed again");
  if (job.status === "UNKNOWN" && confirmUncertain !== true) throw new Error("Check the printer tray first: this one may already have printed.");
  if (!job.fileRefs) throw new Error("The files are no longer available. Choose them again with Print from PC.");
  findPrinter(String(printerId), job.settings);
  // Fail now, not after queueing, if a file moved or changed.
  for (const ref of job.fileRefs) await readChecked(ref);
  log.info(`[local] ${job.id.slice(0, 8)} printing again${job.status === "UNKNOWN" ? " (last outcome unknown)" : ""}`);
  void runAttempt(job.id, String(printerId));
}

/** Someone checked the tray of an UNKNOWN print: it came out. */
export async function confirmPrinted(jobId: string): Promise<void> {
  const job = find(String(jobId));
  if (job.status !== "UNKNOWN") throw new Error("Only a print waiting to be checked can be marked as printed");
  const attempt = job.attempts[job.attempts.length - 1]!;
  transition(job, attempt, "COMPLETED", { evidence: "operator_confirmed", error: null });
  recordSale(job, attempt.printerId);
  await dropTempFiles(job.fileRefs);
  job.fileRefs = null;
  save(job);
}

export function dismiss(jobId: string): void {
  const job = find(String(jobId));
  if (running.has(job.id)) throw new Error("It's printing; wait for it to finish");
  void dropTempFiles(job.fileRefs);
  write(read().filter((j) => j.id !== job.id));
  publish();
}

/**
 * On start and sign-in: settle jobs that were mid-print when the app closed
 * (UNKNOWN if pages may be out, FAILED if not), and prune old history.
 */
export async function initLocalPrint(): Promise<void> {
  const now = Date.now();
  const kept: Stored[] = [];
  for (const job of read()) {
    if (now - new Date(job.updatedAt).getTime() > KEEP_HISTORY_MS || kept.length >= MAX_HISTORY) {
      await dropTempFiles(job.fileRefs);
      continue;
    }
    const attempt = job.attempts[job.attempts.length - 1];
    if (attempt && !running.has(job.id) && (job.status === "SUBMITTING" || job.status === "PRINTING" || job.status === "QUEUED")) {
      const handedOff = attempt.handedOff;
      Object.assign(attempt, {
        status: handedOff ? "UNKNOWN" : "FAILED",
        evidence: "recovered",
        error: handedOff ? "Zerox Buddy closed while this was printing. Check the tray." : "Zerox Buddy closed before printing it.",
        finishedAt: new Date().toISOString(),
      });
      job.status = attempt.status;
      job.error = attempt.error;
      log.info(`[local] ${job.id.slice(0, 8)} recovered after restart → ${job.status}`);
    }
    if (job.fileRefs && now - new Date(job.createdAt).getTime() > KEEP_FILES_MS) {
      await dropTempFiles(job.fileRefs);
      job.fileRefs = null;
    }
    kept.push(job);
  }
  write(kept);
  publish();
}

/** For the queue screen after sign-in to another shop. */
export function refreshLocalJobs(): void {
  publish();
}
