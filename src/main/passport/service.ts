import { app, dialog } from "electron";
import type { BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import type { Margins } from "../../shared/passport/layout";
import { resolvePaper } from "../../shared/passport/paper";
import { layoutSheet, parseSheetSettings, type PassportSheetSettings } from "../../shared/passport/sheet";
import { outputPixelSize } from "../../shared/passport/crop";
import type { IncomingPhoto, LoadedPhoto, PassportPrintResult, PrintCapabilities, PrintTicketOptions, PrintType, ServerPrinter } from "../../shared/types";
import { ApiError, deviceRequest } from "../auth/api-client";
import { wsEvents } from "../ws/ws-client";
import { log } from "../log";
import { printHtmlExact } from "../printing/processor";
import { getPrintCapabilities, openPrinterPreferences } from "../printing/print-ticket";
import { canPrint } from "../printing/router";
import { recordOrder } from "../scanning/scan-service";
import { getState, update } from "../state";
import { printPage } from "../../shared/passport/print-boxes";
import { buildPassportPdf } from "./pdf";
import { buildSheetHtml } from "./sheet-html";
import { inspectPhoto, jpegDimensions, PHOTO_EXTENSIONS, PhotoError } from "./photo-file";
import { clearPrintableAreaCache, getPrintableArea } from "./printable-area";

/**
 * Passport Photo Studio, main side. The renderer crops and turns the photo
 * (from the original, which is never changed) and hands back one JPEG at the
 * print DPI; everything from there — layout, PDF, printing, recording the
 * order — happens here, on this computer. Customer photos sent through the
 * shop's photo link are downloaded straight from the private bucket.
 */

/** When Windows can't say where the printer stops, keep at least this much clear. */
export const FALLBACK_HARD_MARGIN_MM = 5;
const FALLBACK: Margins = { top: FALLBACK_HARD_MARGIN_MM, right: FALLBACK_HARD_MARGIN_MM, bottom: FALLBACK_HARD_MARGIN_MM, left: FALLBACK_HARD_MARGIN_MM };

function message(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong";
}

function assertFeature(): void {
  if (!getState().entitlements?.features.passport_photo) throw new Error("Passport photos aren't in your plan");
}

// ─── photos in ───────────────────────────────────────────────────────────────

function toLoaded(bytes: Uint8Array, name: string, incoming: { id: string; presetId: string | null } | null): LoadedPhoto {
  const info = inspectPhoto(bytes);
  return {
    name,
    dataUrl: `data:${info.mime};base64,${Buffer.from(bytes).toString("base64")}`,
    width: info.width,
    height: info.height,
    incomingId: incoming?.id ?? null,
    presetId: incoming?.presetId ?? null,
  };
}

/** Native file picker → the original photo. Null when cancelled. */
export async function pickPhoto(win: BrowserWindow): Promise<LoadedPhoto | null> {
  assertFeature();
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: "Choose a photo",
    properties: ["openFile"],
    filters: [{ name: "Photos (JPEG, PNG)", extensions: PHOTO_EXTENSIONS }],
  });
  if (canceled || !filePaths[0]) return null;
  const path = filePaths[0];
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (!PHOTO_EXTENSIONS.includes(ext)) throw new PhotoError("Choose a JPEG or PNG photo");
  return toLoaded(new Uint8Array(await readFile(path)), basename(path), null);
}

/** Approved photos (cropped JPEGs at print size), by id. Only the latest few are kept. */
const approved = new Map<string, { jpeg: Uint8Array; widthPx: number; heightPx: number }>();
const KEEP_APPROVED = 4;

/**
 * The renderer's cropped photo, checked: a real JPEG, exactly the pixel size
 * the photo's physical size needs at the chosen DPI. Returns its id.
 */
export function acceptPhoto(raw: unknown, expected: { widthMm: number; heightMm: number; dpi: number }): string {
  assertFeature();
  if (!(raw instanceof Uint8Array)) throw new Error("The cropped photo didn't come through. Try again");
  const want = outputPixelSize(Number(expected.widthMm), Number(expected.heightMm), Number(expected.dpi));
  const got = jpegDimensions(raw);
  if (!got) throw new Error("The cropped photo isn't a valid JPEG. Try again");
  if (got.width !== want.width || got.height !== want.height) {
    throw new Error(`The cropped photo is ${got.width} × ${got.height} px; it should be ${want.width} × ${want.height} px`);
  }
  const id = randomUUID();
  approved.set(id, { jpeg: raw, widthPx: got.width, heightPx: got.height });
  while (approved.size > KEEP_APPROVED) approved.delete(approved.keys().next().value as string);
  return id;
}

function approvedPhoto(id: unknown): Uint8Array {
  const hit = approved.get(String(id));
  if (!hit) throw new Error("Approve the photo again before making the sheet");
  return hit.jpeg;
}

// ─── printers ────────────────────────────────────────────────────────────────

function findPrinter(printerId: unknown): ServerPrinter {
  const printer = getState().printers.find((p) => p.id === String(printerId));
  if (!printer) throw new Error("Choose a printer");
  return printer;
}

/**
 * The printer's portrait hard margins for this paper, as the preview and the
 * print both use them. `known` false means Windows couldn't say, and a safe
 * minimum is used instead.
 */
export async function printerMargins(printerId: unknown, settingsRaw: unknown): Promise<{ hardMargins: Margins; known: boolean }> {
  const printer = findPrinter(printerId);
  const settings = parseSheetSettings(settingsRaw);
  if (settings.paperSize === "CUSTOM") return { hardMargins: FALLBACK, known: false };
  const area = await getPrintableArea(printer.systemName, resolvePaper(settings.paperSize, "PORTRAIT"));
  return area ? { hardMargins: area.hardMargins, known: true } : { hardMargins: FALLBACK, known: false };
}

export async function printOptions(printerId: unknown, fresh = false): Promise<PrintCapabilities | null> {
  return getPrintCapabilities(findPrinter(printerId).systemName, { fresh });
}

export async function printerPreferences(printerId: unknown): Promise<void> {
  await openPrinterPreferences(findPrinter(printerId).systemName);
  clearPrintableAreaCache();
}

// ─── export & print ──────────────────────────────────────────────────────────

function sheetTitle(settings: PassportSheetSettings): string {
  return `Passport photos ${settings.photo.widthMm}×${settings.photo.heightMm} mm`;
}

/** Saves the sheet as a PDF, at exact size in the sheet's own orientation. Null when cancelled. */
export async function exportPdf(win: BrowserWindow, photoId: unknown, settingsRaw: unknown): Promise<string | null> {
  assertFeature();
  const settings = parseSheetSettings(settingsRaw);
  const layout = layoutSheet(settings);
  if (layout.errors.length) throw new Error(layout.errors[0]);
  const { bytes } = await buildPassportPdf(approvedPhoto(photoId), layout, { border: settings.border, title: sheetTitle(settings) });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: "Save passport photo sheet",
    defaultPath: join(app.getPath("documents"), `passport-photos-${stamp}.pdf`),
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (canceled || !filePath) return null;
  await writeFile(filePath, bytes);
  return filePath;
}

export type PrintSheetRequest = {
  clientRef: string;
  photoId: string;
  settings: unknown;
  printerId: string;
  /** How many of each sheet. */
  copies: number;
  printType: PrintType;
  ticket?: PrintTicketOptions | null;
  /** The customer photo it came from, marked done once printed. */
  incomingId?: string | null;
};

/** clientRefs being printed right now, and those already printed (with their result). */
const printing = new Set<string>();
const printed = new Map<string, PassportPrintResult>();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Prints the sheet at exactly 100% and records it as a PHOTO_SHEET order.
 * The same clientRef twice prints once: a second press while it's printing is
 * refused, and a retry after it printed returns the first result. A failed
 * print isn't recorded, so it can be retried with the same clientRef.
 */
export async function printSheet(req: PrintSheetRequest): Promise<PassportPrintResult> {
  assertFeature();
  const clientRef = String(req.clientRef);
  if (!UUID.test(clientRef)) throw new Error("Something went wrong preparing the print. Try again");
  const done = printed.get(clientRef);
  if (done) return done;
  if (printing.has(clientRef)) throw new Error("This sheet is already printing");

  const settings = parseSheetSettings(req.settings);
  if (settings.paperSize === "CUSTOM") throw new Error("Custom paper sizes can be saved as a PDF but not printed here. Choose A4 or 4 × 6 in");
  const printer = findPrinter(req.printerId);
  if (!printer.isEnabled) throw new Error(`${printer.displayName} is turned off in Zerox Buddy`);
  if (printer.status === "OFFLINE" || printer.status === "ERROR") {
    throw new Error(`${printer.displayName} is ${printer.status === "OFFLINE" ? "offline" : "showing an error"}. Check it and try again`);
  }
  const printType: PrintType = req.printType === "BW" ? "BW" : "COLOR";
  if (!canPrint(printer, { printType, paperSize: settings.paperSize, duplex: false })) {
    const why = !printer.paperSizes.includes(settings.paperSize)
      ? `isn't set up for ${settings.paperSize === "4X6" ? "4 × 6 in" : settings.paperSize} paper (change it on the Printers screen)`
      : "can't print in colour";
    throw new Error(`${printer.displayName} ${why}`);
  }
  const copies = Math.min(99, Math.max(1, Math.floor(Number(req.copies) || 1)));
  const photo = approvedPhoto(req.photoId);

  printing.add(clientRef);
  try {
    const { hardMargins } = await printerMargins(printer.id, settings);
    const layout = layoutSheet(settings, hardMargins);
    if (layout.errors.length) throw new Error(layout.errors[0]);
    const sheets = layout.sheets;
    const ticket = req.ticket ?? { dpi: getState().shop?.printDpi ?? null };
    const page = printPage(layout);
    const outcome = await printHtmlExact({
      printer,
      html: buildSheetHtml(layout, "photo.jpg", settings.border),
      files: { "photo.jpg": photo },
      pageMm: { widthMm: page.widthMm, heightMm: page.heightMm },
      sheets,
      copies,
      printType,
      label: `Passport photos (${sheets} sheet${sheets === 1 ? "" : "s"})`,
      // 0 (an old "printer maximum") prints at 1200.
      dpi: ticket.dpi && ticket.dpi > 0 ? ticket.dpi : 1200,
      ticket,
    });
    // Sent: charged once, whatever happens next.
    recordOrder({
      clientRef,
      kind: "PHOTO_SHEET",
      printType,
      paperSize: settings.paperSize,
      pages: sheets,
      copies,
      duplex: false,
      idCard: false,
      printerId: printer.id,
      performedAt: new Date().toISOString(),
    });
    const result: PassportPrintResult = {
      outcome,
      sheets: sheets * copies,
      warning: null,
    };
    printed.set(clientRef, result);
    if (req.incomingId) void finishIncomingPhoto(req.incomingId).catch(() => {});
    return result;
  } finally {
    printing.delete(clientRef);
  }
}

// ─── customer photos (photo link) ────────────────────────────────────────────

let refreshingPhotos: Promise<void> | null = null;
let photoTimer: NodeJS.Timeout | null = null;
let notifyNewPhoto: (photo: IncomingPhoto) => void = () => {};
const PHOTO_POLL_MS = 60_000;

/** Photos customers have sent, waiting at the counter. */
export function refreshIncomingPhotos(): Promise<void> {
  if (!getState().signedIn || !getState().entitlements?.features.passport_photo) return Promise.resolve();
  refreshingPhotos ??= (async () => {
    try {
      const { photos } = await deviceRequest<{ photos: IncomingPhoto[] }>("/photos");
      const known = new Set(getState().incomingPhotos.map((p) => p.id));
      update({ incomingPhotos: photos });
      for (const p of photos) if (p.status === "READY" && !known.has(p.id)) notifyNewPhoto(p);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 0)) log.warn("[passport] incoming photos", message(err));
    } finally {
      refreshingPhotos = null;
    }
  })();
  return refreshingPhotos;
}

/** Downloads a customer's photo into the editor; the server marks it opened. */
export async function openIncomingPhoto(id: unknown): Promise<LoadedPhoto> {
  assertFeature();
  const photo = getState().incomingPhotos.find((p) => p.id === String(id));
  if (!photo) throw new Error("That photo is no longer available");
  const { url } = await deviceRequest<{ url: string }>(`/photos/${encodeURIComponent(photo.id)}/url`, { method: "POST" });
  let bytes: Uint8Array;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    throw new Error(`Couldn't download the photo: ${message(err)}`);
  }
  const loaded = toLoaded(bytes, `Photo ${photo.pickupCode}`, { id: photo.id, presetId: photo.presetId });
  await deviceRequest(`/photos/${encodeURIComponent(photo.id)}/opened`, { method: "POST" }).catch(() => {});
  void refreshIncomingPhotos();
  return loaded;
}

/** Done with a customer's photo (printed or dismissed): the server deletes it. */
export async function finishIncomingPhoto(id: unknown): Promise<void> {
  const photoId = String(id);
  await deviceRequest(`/photos/${encodeURIComponent(photoId)}`, { method: "DELETE" });
  update({ incomingPhotos: getState().incomingPhotos.filter((p) => p.id !== photoId) });
}

/** The shop's photo link, for the counter to share. */
export async function photoLink(): Promise<{ url: string }> {
  const { qr } = await deviceRequest<{ qr: { url: string; photoUrl?: string } }>("/shop/qr");
  if (!qr.photoUrl) throw new Error("The photo link isn't available yet. Update the server");
  return { url: qr.photoUrl };
}

function onWsFrame(frame: { type?: unknown }): void {
  if (frame?.type === "ZEROX_PHOTO_RECEIVED" || frame?.type === "RECONNECTED") void refreshIncomingPhotos();
}

/** Watches for customer photos: on every photo event, and every minute as a backstop. */
export function startPhotoWatch(notify: (photo: IncomingPhoto) => void): void {
  notifyNewPhoto = notify;
  wsEvents.off("message", onWsFrame);
  wsEvents.on("message", onWsFrame);
  if (photoTimer) clearInterval(photoTimer);
  photoTimer = setInterval(() => void refreshIncomingPhotos(), PHOTO_POLL_MS);
  void refreshIncomingPhotos();
}

export function stopPhotoWatch(): void {
  wsEvents.off("message", onWsFrame);
  if (photoTimer) clearInterval(photoTimer);
  photoTimer = null;
  approved.clear();
  printed.clear();
  update({ incomingPhotos: [] });
}
