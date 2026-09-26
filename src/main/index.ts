import { app, BrowserWindow, Notification, shell } from "electron";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { login, logout } from "./auth/api-client";
import { loadPersistedSession } from "./auth/token-store";
import { APP_ID } from "./config";
import { handle, registerAppHandlers } from "./ipc";
import { log } from "./log";
import {
  deleteJob,
  preview,
  printNow,
  printTestPage,
  putBack,
  refreshQueue,
  retryFailed,
  setNotifier,
  setSignedOutHandler,
  startProcessor,
  stopProcessor,
  syncPrinters,
  updatePrinter,
  updatePrintSettings,
} from "./printing/processor";
import { downloadQr, getQr } from "./qr";
import { getState, resetForSignOut, stateEvents, update } from "./state";
import { getSubscription } from "./subscription";
import { createTray, resourcePath, updateTray } from "./tray";
import { registerUpdaterHandlers } from "./updater/ipc";
import { runStartupUpdateCheck } from "./updater/updater-service";
import { startWsClient, stopWsClient, wsEvents } from "./ws/ws-client";

/**
 * Zerox Buddy Desktop — main process.
 *
 * One instance per computer (a second launch focuses the first). Starts
 * hidden in the tray when Windows starts it; closing the window hides it and
 * printing carries on. Quit only from the tray menu.
 */

// Dev and test runs launch node_modules' electron.exe; sharing the installed
// app's id makes Windows pin its Electron icon onto Zerox Buddy's taskbar entry.
app.setAppUserModelId(app.isPackaged ? APP_ID : `${APP_ID}.dev`);

let mainWindow: BrowserWindow | null = null;
let quitting = false;

function showWindow(): void {
  if (!mainWindow) mainWindow = createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#f2ede1",
    title: "Zerox Buddy",
    icon: resourcePath("icon.png"),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.on("ready-to-show", () => {
    if (!process.argv.includes("--hidden")) win.show();
  });
  // Close = hide to tray; printing keeps going.
  win.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  win.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://") && !url.startsWith(process.env["ELECTRON_RENDERER_URL"] ?? "\0")) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  if (!app.isPackaged && process.env["ELECTRON_RENDERER_URL"]) void win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  else void win.loadFile(join(__dirname, "../renderer/index.html"));
  return win;
}

// ─── session lifecycle ───────────────────────────────────────────────────────

async function beginSession(): Promise<void> {
  update({ signedIn: true });
  startWsClient();
  await startProcessor();
}

async function endSession(): Promise<void> {
  stopProcessor();
  stopWsClient();
  resetForSignOut();
}

setSignedOutHandler(() => {
  void endSession();
  new Notification({ title: "Zerox Buddy signed out", body: "Sign in again to keep printing." }).show();
  showWindow();
});

setNotifier((title, body) => {
  if (Notification.isSupported()) new Notification({ title, body, silent: true }).show();
});

wsEvents.on("status", (connection) => update({ connection }));
stateEvents.on("change", (state) => {
  updateTray(state);
  mainWindow?.webContents.send("state", state);
});

function registerHandlers(): void {
  registerAppHandlers();
  registerUpdaterHandlers(() => mainWindow, showWindow);
  handle("auth:login", async (email: string, password: string) => {
    await login(String(email).trim().toLowerCase(), String(password));
    await beginSession();
  });
  handle("auth:logout", async () => {
    await logout();
    await endSession();
  });
  handle("queue:refresh", () => refreshQueue());
  handle("jobs:print", (jobId: string, printerId: string) => printNow(jobId, printerId));
  handle("jobs:preview", (jobId: string, printerId: string) => preview(jobId, printerId));
  handle("jobs:putBack", (jobId: string) => putBack(jobId));
  handle("jobs:retry", (jobId: string) => retryFailed(jobId));
  handle("jobs:delete", (jobId: string) => deleteJob(String(jobId)));
  handle("printers:refresh", () => syncPrinters());
  handle("printers:update", (id: string, patch: Record<string, unknown>) => updatePrinter(id, patch));
  handle("printers:test", (id: string) => printTestPage(id));
  handle("printSettings:update", (patch: Record<string, unknown>) => updatePrintSettings(patch));
  handle("subscription:get", () => getSubscription());
  handle("qr:get", () => getQr());
  handle("qr:download", (format: "png" | "svg" | "pdf") => {
    if (!mainWindow) throw new Error("Window not ready");
    return downloadQr(mainWindow, format);
  });
  handle("app:setStartWithWindows", (enabled: boolean) => {
    app.setLoginItemSettings({ openAtLogin: !!enabled, args: ["--hidden"] });
    update({ startWithWindows: app.getLoginItemSettings({ args: ["--hidden"] }).openAtLogin });
  });
}

// ─── startup ─────────────────────────────────────────────────────────────────

function enableStartWithWindowsOnce(): void {
  const marker = join(app.getPath("userData"), "first-run-done");
  if (existsSync(marker)) return;
  app.setLoginItemSettings({ openAtLogin: true, args: ["--hidden"] });
  writeFileSync(marker, new Date().toISOString());
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);

  void app.whenReady().then(async () => {
    log.info(`[app] Zerox Buddy Desktop ${app.getVersion()} starting`);
    registerHandlers();

    // Installed copies start with Windows by default (a counter PC gets
    // rebooted); the owner can turn it off in Settings.
    if (app.isPackaged) enableStartWithWindowsOnce();
    update({ startWithWindows: app.getLoginItemSettings({ args: ["--hidden"] }).openAtLogin });

    createTray({
      show: showWindow,
      quit: () => {
        quitting = true;
        app.quit();
      },
    });
    updateTray(getState());

    mainWindow = createWindow();
    if (app.isPackaged) {
      const win = mainWindow;
      win.webContents.once("did-finish-load", () => void runStartupUpdateCheck(win));
    }
    if (await loadPersistedSession()) await beginSession();
  });
}

// Keep running in the tray when every window is closed.
app.on("window-all-closed", () => {});
app.on("before-quit", () => {
  quitting = true;
  stopProcessor();
  stopWsClient();
});
