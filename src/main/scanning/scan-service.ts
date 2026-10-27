import { app, dialog, nativeImage, shell } from "electron";
import type { BrowserWindow, NativeImage } from "electron";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { clampCrop, isFull } from "../../shared/crop";
import type { CopyOptions, CounterOrder, CropRect, SaveScanOptions, ScanOptions, ScanPage, ScanRotation, ScanSource, ScanState } from "../../shared/types";
import { log } from "../log";
import { findCardBox } from "./autocrop";
import { printLocalCopy } from "../printing/processor";
import { canPrint } from "../printing/router";
import { getState, update } from "../state";
import { composePdf } from "./compose";
import { listScanners, scanPages, scanningAvailable } from "./naps2";
import { addOrder, pendingOrders, syncOrders } from "./outbox";

/**
 * The Scan screen's work, all on this computer:
 *
 *   scan       NAPS2 → page images in userData/scans/current (one session
 *              at a time; "New scan" clears it)
 *   edit       rotate / crop / delete / reorder / rescan one page / scan its back;
 *              ID cards are cropped to the card automatically (autocrop.ts)
 *   save       PDF into the scan folder, then recorded as a SCAN order
 *   photocopy  PDF → printed on the chosen printer, then recorded as a
 *              PHOTOCOPY order once it's out
 *
 * Orders go through outbox.ts, so they're kept while offline and synced later.
 */

const SYNC_MS = 60_000;
/** The card-sized corner of the glass scanned for an ID card copy. */
const ID_CARD_AREA = "100x70mm";

type PageFile = { path: string; dpi: number };

const files = new Map<string, PageFile>();
let syncTimer: NodeJS.Timeout | null = null;

function sessionDir(): string {
  return join(app.getPath("userData"), "scans", "current");
}

function settingsFile(): string {
  return join(app.getPath("userData"), "scan-settings.json");
}

function defaultFolder(): string {
  return join(app.getPath("documents"), "Zerox Buddy Scans");
}

function setScan(patch: Partial<ScanState>): void {
  update({ scan: { ...getState().scan, ...patch } });
}

function saveSettings(): void {
  const { folder, defaultScannerId, source } = getState().scan;
  try {
    writeFileSync(settingsFile(), JSON.stringify({ folder, defaultScannerId, source }));
  } catch (err) {
    log.warn("[scan] couldn't save settings", err instanceof Error ? err.message : err);
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong";
}

/** Once at startup. Clears any half-finished session left by a crash. */
export async function initScanning(): Promise<void> {
  let saved: { folder?: string; defaultScannerId?: string | null; source?: ScanSource } = {};
  try {
    saved = JSON.parse(readFileSync(settingsFile(), "utf8"));
  } catch {
    // first run
  }
  await rm(sessionDir(), { recursive: true, force: true }).catch(() => {});
  setScan({
    available: scanningAvailable(),
    folder: saved.folder || defaultFolder(),
    defaultScannerId: saved.defaultScannerId ?? null,
    source: saved.source === "feeder" || saved.source === "duplex" ? saved.source : "glass",
  });
}

/** While signed in: sync waiting orders now and every minute. */
export function startOrderSync(): void {
  setScan({ outbox: pendingOrders() });
  void syncNow();
  syncTimer ??= setInterval(() => void syncNow(), SYNC_MS);
}

export function stopOrderSync(): void {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = null;
}

export async function syncNow(): Promise<void> {
  await syncOrders((order, recorded) => {
    const { lastSaved } = getState().scan;
    if (order.kind === "SCAN" && lastSaved && lastSaved.path === order.savedPath) {
      setScan({ lastSaved: { path: recorded.savedPath ?? lastSaved.path, specimenRef: recorded.specimenRef } });
    }
  });
  setScan({ outbox: pendingOrders() });
}

function record(order: Omit<CounterOrder, "clientRef" | "performedAt">): CounterOrder {
  return recordOrder({ ...order, clientRef: randomUUID(), performedAt: new Date().toISOString() });
}

/** Saves a counter order (scan, photocopy, passport sheet) and starts sending it to the server. */
export function recordOrder(full: CounterOrder): CounterOrder {
  addOrder(full);
  setScan({ outbox: pendingOrders() });
  void syncNow();
  return full;
}

// ─── scanners ────────────────────────────────────────────────────────────────

export async function refreshScanners(): Promise<void> {
  if (!getState().scan.available) return;
  setScan({ listing: true, error: null });
  try {
    const scanners = await listScanners();
    const { defaultScannerId } = getState().scan;
    setScan({
      scanners,
      defaultScannerId: defaultScannerId && scanners.some((s) => s.id === defaultScannerId) ? defaultScannerId : (scanners[0]?.id ?? defaultScannerId),
    });
  } catch (err) {
    setScan({ error: `Couldn't look for scanners: ${message(err)}` });
  } finally {
    setScan({ listing: false });
  }
}

export function setDefaultScanner(id: string): void {
  setScan({ defaultScannerId: id });
  saveSettings();
}

export function setSource(source: ScanSource): void {
  setScan({ source: source === "feeder" || source === "duplex" ? source : "glass" });
  saveSettings();
}

// ─── scanning and editing ────────────────────────────────────────────────────

/**
 *   add      append the new pages
 *   replace  rescan one page: the first new page takes its place
 *   back     scan the back of one page (flatbed two-sided): goes right after it
 */
export async function scan(opts: ScanOptions, mode: { add: true } | { replaceId: string } | { backOfId: string }): Promise<void> {
  const state = getState().scan;
  if (state.busy) throw new Error("Wait for the scanner to finish");
  const scanner = state.scanners.find((s) => s.id === opts.scannerId);
  if (!scanner) throw new Error("Choose a scanner first");
  setScan({ busy: "scanning", error: null, lastSaved: null });
  const dir = join(sessionDir(), randomUUID());
  try {
    await mkdir(dir, { recursive: true });
    const source = "replaceId" in mode || "backOfId" in mode || opts.idCard ? "glass" : opts.source;
    const paths = await scanPages(
      { scanner, source, mode: opts.mode, dpi: opts.dpi, pageSize: opts.idCard ? ID_CARD_AREA : opts.paperSize.toLowerCase() },
      dir,
    );
    const added: ScanPage[] = [];
    for (const path of paths) {
      const id = randomUUID();
      files.set(id, { path, dpi: opts.dpi });
      // Pages off a two-sided feeder alternate front, back.
      added.push({ id, rotation: 0, back: source === "duplex" && added.length % 2 === 1, idCard: opts.idCard, crop: opts.idCard ? detectCard(path) : null });
    }
    let pages = [...getState().scan.pages];
    if ("replaceId" in mode) {
      const at = pages.findIndex((p) => p.id === mode.replaceId);
      if (at === -1) throw new Error("That page is gone");
      const [first] = added;
      forgetFile(mode.replaceId);
      for (const extra of added.slice(1)) forgetFile(extra.id);
      pages[at] = { ...first!, back: pages[at]!.back };
    } else if ("backOfId" in mode) {
      const at = pages.findIndex((p) => p.id === mode.backOfId);
      if (at === -1) throw new Error("That page is gone");
      for (const extra of added.slice(1)) forgetFile(extra.id);
      pages.splice(at + 1, 0, { ...added[0]!, back: true });
    } else {
      pages = [...pages, ...added];
    }
    setScan({ pages });
    log.info(`[scan] ${paths.length} page(s) from ${scanner.id}`);
  } catch (err) {
    setScan({ error: message(err) });
    throw err;
  } finally {
    setScan({ busy: null });
  }
}

function forgetFile(id: string): void {
  const f = files.get(id);
  files.delete(id);
  if (f) void rm(f.path, { force: true }).catch(() => {});
}

export function rotatePage(id: string, turn: "left" | "right"): void {
  const step = turn === "right" ? 90 : 270;
  setScan({ pages: getState().scan.pages.map((p) => (p.id === id ? { ...p, rotation: (((p.rotation + step) % 360) as ScanRotation) } : p)) });
}

export function deletePage(id: string): void {
  forgetFile(id);
  setScan({ pages: getState().scan.pages.filter((p) => p.id !== id) });
}

export function movePage(id: string, toIndex: number): void {
  const pages = [...getState().scan.pages];
  const from = pages.findIndex((p) => p.id === id);
  if (from === -1) return;
  const [page] = pages.splice(from, 1);
  pages.splice(Math.max(0, Math.min(toIndex, pages.length)), 0, page!);
  setScan({ pages });
}

export async function clearPages(): Promise<void> {
  for (const id of files.keys()) forgetFile(id);
  setScan({ pages: [], error: null, lastSaved: null });
  await rm(sessionDir(), { recursive: true, force: true }).catch(() => {});
}

// ─── crop ────────────────────────────────────────────────────────────────────

/** The card in an ID card scan, found on a small copy; null keeps the whole scan. */
function detectCard(path: string): CropRect | null {
  try {
    const image = nativeImage.createFromPath(path);
    if (image.isEmpty()) return null;
    const small = image.resize({ width: 400, quality: "good" });
    const { width, height } = small.getSize();
    return findCardBox(small.toBitmap(), width, height);
  } catch (err) {
    log.warn("[scan] couldn't look for the card", err instanceof Error ? err.message : err);
    return null;
  }
}

/** The page's scan with its crop applied. */
function pageImage(page: ScanPage): NativeImage | null {
  const f = files.get(page.id);
  if (!f) return null;
  const image = nativeImage.createFromPath(f.path);
  if (image.isEmpty() || isFull(page.crop)) return image.isEmpty() ? null : image;
  const { width, height } = image.getSize();
  const c = page.crop!;
  return image.crop({
    x: Math.round(c.x * width),
    y: Math.round(c.y * height),
    width: Math.max(1, Math.round(c.w * width)),
    height: Math.max(1, Math.round(c.h * height)),
  });
}

/** "auto" looks for the card again; null keeps the whole scan. */
export function setCrop(id: string, crop: CropRect | "auto" | null): void {
  const page = getState().scan.pages.find((p) => p.id === id);
  if (!page) throw new Error("That page is gone");
  let next: CropRect | null;
  if (crop === "auto") {
    const f = files.get(id);
    next = f ? detectCard(f.path) : null;
    if (!next) throw new Error("Couldn't find the card in this scan. Drag the corners instead.");
  } else {
    next = crop && !isFull(crop) ? clampCrop(crop) : null;
  }
  setScan({ pages: getState().scan.pages.map((p) => (p.id === id ? { ...p, crop: next } : p)) });
}

/** A small preview of one page, cropped, as a data: URL (the renderer can't read files). */
export function thumbnail(id: string): string | null {
  const page = getState().scan.pages.find((p) => p.id === id);
  const image = page && pageImage(page);
  if (!image) return null;
  return image.resize({ width: 320, quality: "good" }).toDataURL();
}

/** The whole scan, uncropped and larger, for the crop editor. */
export function preview(id: string): string | null {
  const f = files.get(id);
  if (!f) return null;
  const image = nativeImage.createFromPath(f.path);
  if (image.isEmpty()) return null;
  return image.resize({ width: 1200, quality: "good" }).toDataURL();
}

async function composeCurrent(paperSize: SaveScanOptions["paperSize"], idCard: boolean) {
  const pages = getState().scan.pages;
  const composed = [];
  for (const p of pages) {
    const f = files.get(p.id);
    if (!f) throw new Error("A scanned page is missing. Scan it again.");
    // Same pixels per inch after cropping, so the card still prints at its real size.
    const jpeg = isFull(p.crop) ? new Uint8Array(await readFile(f.path)) : new Uint8Array(pageImage(p)!.toJPEG(92));
    composed.push({ jpeg, rotation: p.rotation, dpi: f.dpi });
  }
  return composePdf(composed, { paperSize, idCard });
}

function assertFeature(feature: "scan" | "photocopy"): void {
  if (!getState().entitlements?.features[feature]) {
    throw new Error(feature === "scan" ? "Scanning isn't in your plan" : "Photocopying isn't in your plan");
  }
}

// ─── save as PDF ─────────────────────────────────────────────────────────────

function stamp(d = new Date()): { day: string; time: string } {
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    day: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`,
  };
}

export async function saveScan(opts: SaveScanOptions): Promise<string> {
  assertFeature("scan");
  if (getState().scan.busy) throw new Error("Wait for the scanner to finish");
  const pageCount = getState().scan.pages.length;
  setScan({ busy: "saving", error: null });
  try {
    const { bytes } = await composeCurrent(opts.paperSize, false);
    const { day, time } = stamp();
    const dir = join(getState().scan.folder, day);
    await mkdir(dir, { recursive: true });
    // Named by time until the order is recorded, then renamed to its specimen reference.
    const path = join(dir, `scan-${time}.pdf`);
    const tmp = `${path}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, path);
    record({ kind: "SCAN", printType: opts.printType, paperSize: opts.paperSize, pages: pageCount, copies: 1, duplex: false, idCard: false, savedPath: path });
    await clearPages();
    setScan({ lastSaved: { path, specimenRef: null } });
    log.info(`[scan] saved ${pageCount} page(s) to ${path}`);
    return path;
  } catch (err) {
    setScan({ error: `Couldn't save: ${message(err)}` });
    throw err;
  } finally {
    setScan({ busy: null });
  }
}

export function openSaved(which: "file" | "folder"): void {
  const saved = getState().scan.lastSaved;
  if (which === "file" && saved) void shell.openPath(saved.path);
  else if (saved) shell.showItemInFolder(saved.path);
  else void shell.openPath(getState().scan.folder);
}

export async function chooseFolder(win: BrowserWindow | null): Promise<string | null> {
  const opts = { title: "Where should scans be saved?", defaultPath: getState().scan.folder, properties: ["openDirectory", "createDirectory"] as ("openDirectory" | "createDirectory")[] };
  const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  const folder = result.canceled ? null : (result.filePaths[0] ?? null);
  if (folder) {
    setScan({ folder });
    saveSettings();
  }
  return folder;
}

// ─── photocopy ───────────────────────────────────────────────────────────────

export async function printCopy(opts: CopyOptions): Promise<void> {
  assertFeature("photocopy");
  if (getState().scan.busy) throw new Error("Wait for the scanner to finish");
  const printer = getState().printers.find((p) => p.id === opts.printerId);
  if (!printer) throw new Error("Choose a printer");
  if (!printer.isEnabled) throw new Error(`${printer.displayName} is turned off in Zerox Buddy`);
  if (!canPrint(printer, { printType: opts.printType, paperSize: opts.paperSize, duplex: opts.duplex })) {
    throw new Error(`${printer.displayName} can't print this copy`);
  }
  const copies = Math.min(99, Math.max(1, Math.floor(opts.copies)));
  setScan({ busy: "printing", error: null });
  try {
    const { bytes, sheets } = await composeCurrent(opts.paperSize, opts.idCard);
    await printLocalCopy({
      printer,
      pdf: bytes,
      copies,
      duplex: opts.duplex,
      printType: opts.printType,
      paperSize: opts.paperSize,
      ticket: opts.ticket ?? { dpi: getState().shop?.printDpi ?? null },
    });
    // Recorded once it's out; a failed copy isn't charged.
    record({
      kind: "PHOTOCOPY",
      printType: opts.printType,
      paperSize: opts.paperSize,
      pages: sheets,
      copies,
      duplex: opts.duplex,
      idCard: opts.idCard,
      printerId: printer.id,
    });
  } catch (err) {
    setScan({ error: `Photocopy failed: ${message(err)}` });
    throw err;
  } finally {
    setScan({ busy: null });
  }
}
