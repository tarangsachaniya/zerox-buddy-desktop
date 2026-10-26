/**
 * Shapes shared by the main process and the renderer: what priinteve-api's
 * /api/zerox/device routes return, and the app state main pushes to the UI.
 * Written by hand, mirroring priinteve-api services/zerox/{devices,print-queue}.ts.
 */

export type PrintType = "BW" | "COLOR";
/** References the server's ZeroxPaperSize.code catalog — open-ended, not a fixed pair. */
export type PaperSize = string;
export type Orientation = "AUTO" | "PORTRAIT" | "LANDSCAPE";
export type ScaleMode = "FIT" | "FILL" | "ACTUAL";
export type Margins = "DEFAULT" | "NONE" | "MINIMUM";
export type DuplexFlip = "LONG" | "SHORT";
export type JobStatus =
  | "QUEUED"
  | "ASSIGNED"
  | "DOWNLOADING"
  | "PRINTING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "EXPIRED";
export type PrinterStatus = "ONLINE" | "BUSY" | "ERROR" | "OFFLINE";

export type ShopInfo = {
  id: string;
  shopName: string;
  shopCode: string;
  status: "ACTIVE" | "SUSPENDED";
  autoPrint: boolean;
  autoRouting: boolean;
  requirePreview: boolean;
  autoDeleteFiles: boolean;
  defaultCopies: number;
  /** Print resolution; 300 | 600 | 1200, or 0 for the printer's maximum. Server default 600. */
  printDpi: number;
};

export type Entitlements = {
  planCode: string;
  planName: string;
  printerLimit: number;
  features: Features;
  trialEndsAt: string | null;
  trialExpired: boolean;
};

export type Features = {
  color: boolean;
  a3: boolean;
  duplex: boolean;
  smart_routing: boolean;
  passport_photo: boolean;
  print_preview: boolean;
  reports: boolean;
  printer_monitoring: boolean;
  /** Scan to PDF at the counter. */
  scan?: boolean;
  /** Photocopy and ID card copy at the counter. */
  photocopy?: boolean;
  monthly_job_limit: number | null;
};

/** GET /api/zerox/plans — public, unauthenticated (the marketing pricing catalog). */
export type Plan = {
  code: string;
  name: string;
  description: string;
  priceMonthly: number;
  printerLimit: number;
  features: Features;
};

/** GET /api/zerox/device/subscription — mirrors priinteve-zerox's lib/types.ts OwnerSubscription. */
export type OwnerSubscription = {
  plan: {
    code: string;
    name: string;
    description: string;
    priceMonthly: number;
    printerLimit: number;
    features: Features;
  };
  expiresAt: string | null;
  isFallback: boolean;
  trialEndsAt: string | null;
  trialExpired: boolean;
  subscription: {
    planCode: string;
    planName: string;
    status: "ACTIVE" | "EXPIRED" | "SUSPENDED";
    startsAt: string;
    expiresAt: string | null;
  } | null;
  usage: { jobsThisMonth: number; jobLimit: number | null; printers: number; printerLimit: number };
};

export type ServerPrinter = {
  id: string;
  deviceId: string;
  systemName: string;
  displayName: string;
  isEnabled: boolean;
  priority: number;
  supportsColor: boolean;
  supportsDuplex: boolean;
  paperSizes: PaperSize[];
  capabilitiesOverridden: boolean;
  /** Two-sided by hand: front sheets, flip the stack, back sheets. Owner-set. */
  manualDuplex: boolean;
  /** Order the back sides print in; depends on how the printer stacks its output. */
  manualDuplexEvenOrder: "REVERSE" | "FORWARD";
  /** Which pages print before the flip. */
  manualDuplexFirst: "ODD" | "EVEN";
  manualDuplexNote: string | null;
  /** Owner-set print speed; a pass is never treated as finished sooner than this allows. */
  pagesPerMinute: number;
  status: PrinterStatus;
  statusMessage: string | null;
  lastSeenAt: string | null;
};

/**
 * The operator's answer to a two-sided prompt.
 *   flip         continue | reprintFront | cancel
 *   confirmDone  done | reprint (the last pass again) | problem (mark failed)
 */
export type ManualDuplexAnswer = "continue" | "reprintFront" | "cancel" | "done" | "reprint" | "problem";

type PromptBase = {
  jobId: string;
  specimenNo: number | null;
  printerName: string;
  /** The app couldn't confirm the printer finished (queue unreadable or stuck): say so. */
  uncertain: boolean;
};

/**
 * Shown to the operator on a two-sided job:
 *   flip         between the front and back passes of a manual double-sided job
 *   confirmDone  after the last pass, before the job is reported printed
 */
export type ManualDuplexPrompt = FlipPrompt | ConfirmDonePrompt;

export type ConfirmDonePrompt = PromptBase & {
  stage: "confirmDone";
  /** Sheets in the last pass (back sides by hand, or the whole job on a duplex printer). */
  sheets: number;
  byHand: boolean;
};

export type FlipPrompt = PromptBase & {
  stage: "flip";
  flip: DuplexFlip;
  evenOrder: "REVERSE" | "FORWARD";
  /** Which pages already printed; the other set prints next. */
  first: "ODD" | "EVEN";
  note: string | null;
  frontSheets: number;
  backSheets: number;
  /** The last back side is a blank pad, because the page count is odd. */
  oddCount: boolean;
};

/** One entry in the admin-managed paper-size catalog (e.g. {code:"A4",label:"A4"}). */
export type PaperSizeCatalogEntry = {
  code: string;
  label: string;
  requiresA3Feature: boolean;
  supportsColor: boolean;
  supportsPhotoSheet: boolean;
  supportsLandscape: boolean;
};

/** PAGE / PHOTO_SHEET for online orders; SCAN / COPY per page at the counter. */
export type PriceKind = "PAGE" | "PHOTO_SHEET" | "SCAN" | "COPY";

/** One row of the shop's rate card — mirrors priinteve-zerox's lib/types.ts PriceRule. */
export type PriceRule = {
  kind: PriceKind;
  paperSize: PaperSize;
  printType: PrintType;
  price: number;
  updatedAt?: string;
};

export type Bootstrap = {
  shop: ShopInfo;
  entitlements: Entitlements;
  printers: ServerPrinter[];
  paperSizeCatalog: PaperSizeCatalogEntry[];
};

/** GET /api/zerox/device/shop/qr. */
export type ShopQr = { url: string; createdAt: string };

/** ShopQr plus a data: URL of the PNG, ready for an <img> preview. */
export type QrPreview = ShopQr & { pngDataUrl: string };

export type JobFile = {
  id: string;
  originalName: string;
  mimeType: string;
  size: number;
  pageCount: number | null;
  pageRanges: string | null;
  selectedPages: number | null;
};

export type QueueJob = {
  id: string;
  status: JobStatus;
  specimenNo: number | null;
  specimenRef: string | null;
  printType: PrintType | null;
  paperSize: PaperSize | null;
  copies: number;
  duplex: boolean;
  orientation: Orientation;
  scaleMode: ScaleMode;
  margins: Margins;
  bleedMm: number;
  pagesPerSheet: number;
  duplexFlip: DuplexFlip;
  totalPages: number;
  amount: number;
  paymentStatus: "PENDING" | "PAID";
  queuedAt: string | null;
  completedAt: string | null;
  assignedDeviceId: string | null;
  assignedPrinterId: string | null;
  files: JobFile[];
  lastAttempt: { id: string; status: string; error: string | null; printerId: string; deviceId: string } | null;
};

export type DeviceQueue = { waiting: QueueJob[]; active: QueueJob[]; recent: QueueJob[] };

/** A Windows printer as this computer sees it right now. */
export type DetectedPrinter = {
  systemName: string;
  supportsColor: boolean;
  supportsDuplex: boolean;
  paperSizes: PaperSize[];
  status: PrinterStatus;
  statusMessage?: string;
};

/** What this computer is doing with a job right now (local, not from the server). */
export type LocalJobState = {
  jobId: string;
  phase: "claiming" | "downloading" | "printing" | "done" | "failed";
  printerName?: string;
  message?: string;
};

export type Connection = "online" | "connecting" | "offline";

/** Everything the renderer draws, pushed by main on every change. */
export type AppState = {
  signedIn: boolean;
  version: string;
  connection: Connection;
  shop: ShopInfo | null;
  entitlements: Entitlements | null;
  printers: ServerPrinter[];
  paperSizeCatalog: PaperSizeCatalogEntry[];
  queue: DeviceQueue;
  local: Record<string, LocalJobState>;
  /** Why a waiting job can't be routed automatically (jobId → reason). */
  blocked: Record<string, string>;
  lastSyncAt: string | null;
  error: string | null;
  startWithWindows: boolean;
  /** Set while a two-sided job waits for the operator to flip the stack or confirm it's out. */
  manualDuplexPrompt: ManualDuplexPrompt | null;
  /** Jobs this computer was printing when it closed: a person says whether they came out (jobId → details). */
  needsCheck: Record<string, NeedsCheck>;
  scan: ScanState;
};

// ─── scanning (counter scan / photocopy) ─────────────────────────────────────

export type ScanDriver = "wia" | "escl" | "twain";
export type ScanSource = "glass" | "feeder" | "duplex";
export type ScanMode = "color" | "gray" | "bw";
export type ScanRotation = 0 | 90 | 180 | 270;

export type Scanner = { id: string; driver: ScanDriver; name: string };

export type ScanPage = {
  id: string;
  rotation: ScanRotation;
  /** Back of the page before it (scanned with "Scan back"). */
  back: boolean;
};

export type ScanOptions = {
  scannerId: string;
  source: ScanSource;
  mode: ScanMode;
  dpi: number;
  paperSize: PaperSize;
  /** Scan only the card-sized corner of the glass. */
  idCard: boolean;
};

export type SaveScanOptions = { printType: PrintType; paperSize: PaperSize };

export type CopyOptions = {
  printerId: string;
  printType: PrintType;
  paperSize: PaperSize;
  copies: number;
  duplex: boolean;
  idCard: boolean;
};

/** A scan or photocopy not yet recorded on the server (e.g. made offline). */
export type CounterOrder = {
  clientRef: string;
  kind: "SCAN" | "PHOTOCOPY";
  printType: PrintType;
  paperSize: PaperSize;
  pages: number;
  copies: number;
  duplex: boolean;
  idCard: boolean;
  printerId?: string;
  performedAt: string;
  /** Scans: the saved PDF, renamed to the specimen reference once recorded. */
  savedPath?: string;
  /** Why the server refused it last time (it's retried anyway). */
  error?: string;
};

export type ScanState = {
  /** The scanning engine ships with this install (64-bit only). */
  available: boolean;
  scanners: Scanner[];
  listing: boolean;
  defaultScannerId: string | null;
  folder: string;
  busy: "scanning" | "saving" | "printing" | null;
  pages: ScanPage[];
  error: string | null;
  lastSaved: { path: string; specimenRef: string | null } | null;
  outbox: CounterOrder[];
};

export type NeedsCheck = { jobId: string; attemptId: string; specimenNo: number | null };

export type IpcResult<T = unknown> = { ok: true; data: T } | { ok: false; error: string; status?: number };
