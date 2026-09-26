/**
 * Shapes shared by the main process and the renderer: what priinteve-api's
 * /api/zerox/device routes return, and the app state main pushes to the UI.
 * Written by hand, mirroring priinteve-api services/zerox/{devices,print-queue}.ts.
 */

export type PrintType = "BW" | "COLOR";
export type PaperSize = "A4" | "A3";
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
};

export type Entitlements = {
  planCode: string;
  planName: string;
  printerLimit: number;
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
  status: PrinterStatus;
  statusMessage: string | null;
  lastSeenAt: string | null;
};

export type Bootstrap = { shop: ShopInfo; entitlements: Entitlements; printers: ServerPrinter[] };

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
  queue: DeviceQueue;
  local: Record<string, LocalJobState>;
  /** Why a waiting job can't be routed automatically (jobId → reason). */
  blocked: Record<string, string>;
  lastSyncAt: string | null;
  error: string | null;
  startWithWindows: boolean;
};

export type IpcResult<T = unknown> = { ok: true; data: T } | { ok: false; error: string; status?: number };
