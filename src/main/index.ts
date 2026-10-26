import { app, BrowserWindow, Notification, shell } from "electron";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { AppState, CopyOptions, CropRect, ManualDuplexAnswer, SaveScanOptions, ScanOptions, ScanSource } from "../shared/types";
import { login, logout } from "./auth/api-client";
import { loadPersistedSession } from "./auth/token-store";
import { APP_ID } from "./config";
import { handle, registerAppHandlers } from "./ipc";
import { log } from "./log";
import {
  answerManualDuplex,
  confirmPrinted,
  deleteJob,
  preview,
  printNow,
  reprintChecked,
  printTestDuplex,
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
import { getPricing, updatePricing } from "./pricing";
import {
  chooseFolder,
  clearPages,
  deletePage,
  initScanning,
  movePage,
  openSaved,
  preview as previewScan,
  printCopy,
  refreshScanners,
  rotatePage,
  saveScan,
  scan,
  setCrop,
  setDefaultScanner,
  setSource,
  startOrderSync,
  stopOrderSync,
  syncNow,
  thumbnail,
} from "./scanning/scan-service";
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
  startOrderSync();
}

async function endSession(): Promise<void> {
  stopOrderSync();
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

wsEvents.on("status", (connection) => {
  update({ connection });
  // Back online: record scans and photocopies made while offline.
  if (connection === "online") void syncNow();
});

// The printer (or the job's "printed") waits on a person, so the two-sided
// dialog can't sit unseen behind other windows or in the tray: bring the
// window up, flash it in the taskbar and sound a notification, once per prompt.
let flipPromptShown: string | null = null;
function attendToFlipPrompt(state: AppState): void {
  const prompt = state.manualDuplexPrompt;
  const key = prompt ? `${prompt.jobId}:${prompt.stage}` : null;
  if (prompt && flipPromptShown !== key) {
    flipPromptShown = key;
    showWindow();
    mainWindow?.flashFrame(true);
    if (Notification.isSupported()) {
      const job = prompt.specimenNo ? ` for #${prompt.specimenNo}` : "";
      const notice =
        prompt.stage === "flip"
          ? new Notification({ title: `Turn the paper over${job}`, body: `${prompt.first === "ODD" ? "Odd" : "Even"} pages are done. Turn the stack over and put it back in the tray.` })
          : new Notification({ title: `Check the pages${job}`, body: "Confirm every page has come out of the printer." });
      notice.on("click", showWindow);
      notice.show();
    }
  } else if (!prompt && flipPromptShown) {
    flipPromptShown = null;
    mainWindow?.flashFrame(false);
  }
}

stateEvents.on("change", (state) => {
  updateTray(state);
  attendToFlipPrompt(state);
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
  handle("scan:listScanners", () => refreshScanners());
  handle("scan:setDefaultScanner", (id: string) => setDefaultScanner(String(id)));
  handle("scan:setSource", (source: ScanSource) => setSource(source));
  handle("scan:start", (opts: ScanOptions) => scan(opts, { add: true }));
  handle("scan:rescan", (opts: ScanOptions, pageId: string) => scan(opts, { replaceId: String(pageId) }));
  handle("scan:back", (opts: ScanOptions, pageId: string) => scan(opts, { backOfId: String(pageId) }));
  handle("scan:rotate", (pageId: string, turn: "left" | "right") => rotatePage(String(pageId), turn === "left" ? "left" : "right"));
  handle("scan:delete", (pageId: string) => deletePage(String(pageId)));
  handle("scan:move", (pageId: string, toIndex: number) => movePage(String(pageId), Number(toIndex)));
  handle("scan:clear", () => clearPages());
  handle("scan:thumbnail", (pageId: string) => thumbnail(String(pageId)));
  handle("scan:preview", (pageId: string) => previewScan(String(pageId)));
  handle("scan:setCrop", (pageId: string, crop: CropRect | "auto" | null) => setCrop(String(pageId), crop));
  handle("scan:save", (opts: SaveScanOptions) => saveScan(opts));
  handle("scan:open", (which: "file" | "folder") => openSaved(which === "file" ? "file" : "folder"));
  handle("scan:chooseFolder", () => chooseFolder(mainWindow));
  handle("scan:copy", (opts: CopyOptions) => printCopy(opts));
  handle("scan:sync", () => syncNow());
  handle("jobs:confirmPrinted", (jobId: string) => confirmPrinted(String(jobId)));
  handle("jobs:reprintChecked", (jobId: string) => reprintChecked(String(jobId)));
  handle("printers:refresh", () => syncPrinters());
  handle("printers:update", (id: string, patch: Record<string, unknown>) => updatePrinter(id, patch));
  handle("printers:test", (id: string) => printTestPage(id));
  handle("printers:testDuplex", (id: string) => printTestDuplex(id));
  handle("duplex:answer", (answer: ManualDuplexAnswer) => answerManualDuplex(answer));
  handle("printSettings:update", (patch: Record<string, unknown>) => updatePrintSettings(patch));
  handle("subscription:get", () => getSubscription());
  handle("pricing:get", () => getPricing());
  handle("pricing:update", (rules: Parameters<typeof updatePricing>[0]) => updatePricing(rules));
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
    await initScanning();

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
