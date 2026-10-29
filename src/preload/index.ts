import { contextBridge, ipcRenderer } from "electron";

import type {
  AppState,
  Bootstrap,
  CopyOptions,
  CropRect,
  IpcResult,
  LoadedPhoto,
  ManualDuplexAnswer,
  PassportPrintResult,
  PrintCapabilities,
  PrintTicketOptions,
  PrintType,
  OwnerSubscription,
  Plan,
  PriceRule,
  QrPreview,
  LocalPrintJob,
  LocalPrintSettings,
  PickedFile,
  SaveScanOptions,
  ScanOptions,
  ScanSource,
} from "../shared/types";
import type { Margins as PassportMargins } from "../shared/passport/layout";
import type { PassportSheetSettings } from "../shared/passport/sheet";
import type { CheckResult, UpdaterState, UpdaterStatusEvent } from "../shared/updater-types";

/**
 * The whole renderer-reachable surface. The renderer asks main to do things;
 * it never holds a token or touches Node. Every call resolves to an
 * IpcResult ({ ok, data } or { ok: false, error }).
 */
const invoke = <T = void>(channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args) as Promise<IpcResult<T>>;

const api = {
  getState: () => invoke<AppState>("app:getState"),
  onState: (callback: (state: AppState) => void) => {
    const listener = (_event: unknown, state: AppState) => callback(state);
    ipcRenderer.on("state", listener);
    return () => {
      ipcRenderer.removeListener("state", listener);
    };
  },
  login: (email: string, password: string) => invoke("auth:login", email, password),
  logout: () => invoke("auth:logout"),
  refreshQueue: () => invoke("queue:refresh"),
  printJob: (jobId: string, printerId: string) => invoke("jobs:print", jobId, printerId),
  previewJob: (jobId: string, printerId: string) => invoke("jobs:preview", jobId, printerId),
  putBackJob: (jobId: string) => invoke("jobs:putBack", jobId),
  retryJob: (jobId: string) => invoke("jobs:retry", jobId),
  deleteJob: (jobId: string) => invoke("jobs:delete", jobId),
  confirmPrinted: (jobId: string) => invoke("jobs:confirmPrinted", jobId),
  /** FAILED or UNKNOWN → print again on this printer; UNKNOWN needs confirmUncertain (the person was warned about duplicates). */
  reprint: (jobId: string, printerId: string, confirmUncertain: boolean) => invoke("jobs:reprint", jobId, printerId, confirmUncertain),
  scan: {
    listScanners: () => invoke("scan:listScanners"),
    setDefaultScanner: (id: string) => invoke("scan:setDefaultScanner", id),
    setSource: (source: ScanSource) => invoke("scan:setSource", source),
    start: (opts: ScanOptions) => invoke("scan:start", opts),
    rescan: (opts: ScanOptions, pageId: string) => invoke("scan:rescan", opts, pageId),
    back: (opts: ScanOptions, pageId: string) => invoke("scan:back", opts, pageId),
    rotate: (pageId: string, turn: "left" | "right") => invoke("scan:rotate", pageId, turn),
    remove: (pageId: string) => invoke("scan:delete", pageId),
    move: (pageId: string, toIndex: number) => invoke("scan:move", pageId, toIndex),
    clear: () => invoke("scan:clear"),
    thumbnail: (pageId: string) => invoke<string | null>("scan:thumbnail", pageId),
    preview: (pageId: string) => invoke<string | null>("scan:preview", pageId),
    setCrop: (pageId: string, crop: CropRect | "auto" | null) => invoke("scan:setCrop", pageId, crop),
    save: (opts: SaveScanOptions) => invoke<string>("scan:save", opts),
    open: (which: "file" | "folder") => invoke("scan:open", which),
    chooseFolder: () => invoke<string | null>("scan:chooseFolder"),
    copy: (opts: CopyOptions) => invoke("scan:copy", opts),
    sync: () => invoke("scan:sync"),
  },
  passport: {
    pick: () => invoke<LoadedPhoto | null>("passport:pick"),
    /** The cropped photo as JPEG bytes at print size; returns its id. */
    accept: (jpeg: Uint8Array, expected: { widthMm: number; heightMm: number; dpi: number }) => invoke<string>("passport:accept", jpeg, expected),
    printerMargins: (printerId: string, settings: PassportSheetSettings) =>
      invoke<{ hardMargins: PassportMargins; known: boolean }>("passport:printerMargins", printerId, settings),
    /** Saves the sheet as a PDF and opens it in the default viewer; `ask` shows a Save dialog first. */
    exportPdf: (photoId: string, settings: PassportSheetSettings, opts?: { ask?: boolean }) =>
      invoke<string | null>("passport:exportPdf", photoId, settings, opts),
    print: (req: {
      clientRef: string;
      photoId: string;
      settings: PassportSheetSettings;
      printerId: string;
      copies: number;
      printType: PrintType;
      ticket?: PrintTicketOptions | null;
      incomingId?: string | null;
    }) => invoke<PassportPrintResult>("passport:print", req),
    refreshIncoming: () => invoke("passport:refreshIncoming"),
    openIncoming: (id: string) => invoke<LoadedPhoto>("passport:openIncoming", id),
    finishIncoming: (id: string) => invoke("passport:finishIncoming", id),
    photoLink: () => invoke<{ url: string }>("passport:photoLink"),
    /** Saves the photo link as a QR PNG; returns the saved path, or null if cancelled. */
    downloadPhotoQr: () => invoke<string | null>("passport:downloadPhotoQr"),
  },
  /** Print files from this computer, or from Google Drive (picked in the browser). */
  localPrint: {
    pick: () => invoke<(PickedFile | { name: string; error: string })[]>("localPrint:pick"),
    pickFromDrive: () => invoke<(PickedFile | { name: string; error: string })[]>("localPrint:pickFromDrive"),
    remove: (pickId: string) => invoke("localPrint:remove", pickId),
    submit: (pickIds: string[], settings: LocalPrintSettings) => invoke<LocalPrintJob>("localPrint:submit", pickIds, settings),
    retry: (jobId: string, printerId: string, confirmUncertain: boolean) => invoke("localPrint:retry", jobId, printerId, confirmUncertain),
    confirmPrinted: (jobId: string) => invoke("localPrint:confirmPrinted", jobId),
    dismiss: (jobId: string) => invoke("localPrint:dismiss", jobId),
  },
  printOptions: {
    get: (printerId: string, fresh?: boolean) => invoke<PrintCapabilities | null>("printOptions:get", printerId, fresh),
    preferences: (printerId: string) => invoke("printOptions:preferences", printerId),
  },
  refreshPrinters: () => invoke("printers:refresh"),
  updatePrinter: (id: string, patch: Record<string, unknown>) => invoke("printers:update", id, patch),
  testPrinter: (id: string) => invoke("printers:test", id),
  testPrinterDuplex: (id: string) => invoke("printers:testDuplex", id),
  answerManualDuplex: (answer: ManualDuplexAnswer) => invoke("duplex:answer", answer),
  updatePrintSettings: (patch: Record<string, unknown>) => invoke<Bootstrap>("printSettings:update", patch),
  /** Start (true) or close (false) the shop for online uploads. */
  setShopOpen: (open: boolean) => invoke<void>("shop:setOpen", open),
  getSubscription: () => invoke<{ subscription: OwnerSubscription; plans: Plan[] }>("subscription:get"),
  getPricing: () => invoke<{ rules: PriceRule[] }>("pricing:get"),
  updatePricing: (rules: { kind: PriceRule["kind"]; paperSize: string; printType: PriceRule["printType"]; price: number }[]) =>
    invoke<{ rules: PriceRule[] }>("pricing:update", rules),
  getQr: () => invoke<QrPreview>("qr:get"),
  downloadQr: (format: "png" | "svg" | "pdf") => invoke<string | null>("qr:download", format),
  setStartWithWindows: (enabled: boolean) => invoke("app:setStartWithWindows", enabled),
  openLogs: () => invoke("app:openLogs"),
  /** Connection and queue health, for Settings › Diagnostics (no tokens, no file paths). */
  diagnostics: () => invoke<Record<string, unknown>>("app:diagnostics"),
  quit: () => invoke("app:quit"),
  updater: {
    check: () => invoke<CheckResult>("updater:check"),
    startUpdate: () => invoke<{ ok: true } | { ok: false; error: string }>("updater:startUpdate"),
    cancelDownload: () => invoke<{ ok: boolean }>("updater:cancelDownload"),
    getState: () => invoke<UpdaterState>("updater:getState"),
    dismiss: (version: string) => invoke("updater:dismiss", version),
    onStatus: (callback: (status: UpdaterStatusEvent) => void) => {
      const listener = (_event: unknown, status: UpdaterStatusEvent) => callback(status);
      ipcRenderer.on("updater:status", listener);
      return () => {
        ipcRenderer.removeListener("updater:status", listener);
      };
    },
  },
};

export type ZeroxApi = typeof api;

contextBridge.exposeInMainWorld("zerox", api);
