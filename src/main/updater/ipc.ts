import type { BrowserWindow } from "electron";

import { handle } from "../ipc";
import type { UpdaterStatusEvent } from "./types";
import { cancelDownload, checkForUpdates, dismissOptionalUpdate, getState, startUpdate, updaterEvents } from "./updater-service";

export function registerUpdaterHandlers(getWindow: () => BrowserWindow | null, showWindow: () => void): void {
  handle("updater:check", () => checkForUpdates());
  handle("updater:startUpdate", () => startUpdate());
  handle("updater:cancelDownload", () => ({ ok: cancelDownload() }));
  handle("updater:getState", () => getState());
  handle("updater:dismiss", (version: string) => dismissOptionalUpdate(String(version)));

  updaterEvents.on("status", (status: UpdaterStatusEvent) => {
    // A counter PC usually runs hidden in the tray; a required update has to be seen.
    if (status.state === "mandatory-required" || status.state === "offline-blocked") showWindow();
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send("updater:status", status);
  });
}
