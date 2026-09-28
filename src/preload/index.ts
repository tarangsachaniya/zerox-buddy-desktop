import { contextBridge, ipcRenderer } from "electron";

import type { AppState, Bootstrap, IpcResult, OwnerSubscription, Plan, PriceRule, QrPreview } from "../shared/types";
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
  refreshPrinters: () => invoke("printers:refresh"),
  updatePrinter: (id: string, patch: Record<string, unknown>) => invoke("printers:update", id, patch),
  testPrinter: (id: string) => invoke("printers:test", id),
  updatePrintSettings: (patch: Record<string, unknown>) => invoke<Bootstrap>("printSettings:update", patch),
  getSubscription: () => invoke<{ subscription: OwnerSubscription; plans: Plan[] }>("subscription:get"),
  getPricing: () => invoke<{ rules: PriceRule[] }>("pricing:get"),
  updatePricing: (rules: { kind: PriceRule["kind"]; paperSize: string; printType: PriceRule["printType"]; price: number }[]) =>
    invoke<{ rules: PriceRule[] }>("pricing:update", rules),
  getQr: () => invoke<QrPreview>("qr:get"),
  downloadQr: (format: "png" | "svg" | "pdf") => invoke<string | null>("qr:download", format),
  setStartWithWindows: (enabled: boolean) => invoke("app:setStartWithWindows", enabled),
  openLogs: () => invoke("app:openLogs"),
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
