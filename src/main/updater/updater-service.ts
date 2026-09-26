import { app, type BrowserWindow } from "electron";
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { autoUpdater, CancellationToken } from "electron-updater";

import { API_BASE_URL, UPDATE_PLATFORM } from "../config";
import { fetchLatestRelease, postUpdateLog } from "./update-client";
import { updaterLog } from "./logger";
import {
  isBelowMinimum,
  isDismissed,
  isNewer,
  readPolicyCache,
  resolveMandatory,
  shouldBlockOffline,
  updatePolicyCache,
} from "./version-policy";
import type {
  CheckResult,
  LatestReleaseInfo,
  PendingUpdateMarker,
  UpdateFailedMarker,
  UpdaterState,
  UpdaterStatusEvent,
} from "./types";

// Fully manual: nothing downloads or installs itself until our own IPC
// layer (or the mandatory-flow auto-trigger in the renderer) explicitly
// asks for it. This is what makes the mandatory/optional dialog flow
// possible at all — electron-updater's own defaults would silently
// download and install on app quit with no UI involved.
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

// Set at runtime rather than trusting app-update.yml, so each architecture's
// build reads its own feed (see UPDATE_PLATFORM).
autoUpdater.setFeedURL({ provider: "generic", url: `${API_BASE_URL}/api/app-updates/${UPDATE_PLATFORM}/`, channel: "latest" });

// electron-updater logs verbosely by default (to console, which a packaged
// app has nowhere to show) — route it through the same updater-scoped file
// logger as everything else here instead.
autoUpdater.logger = {
  info: (message?: unknown) => updaterLog.info("electron-updater", { message: String(message) }),
  warn: (message?: unknown) => updaterLog.warn("electron-updater", { message: String(message) }),
  error: (message?: unknown) => updaterLog.error("electron-updater", { message: String(message) }),
  debug: () => {
    // Too noisy for a file this low-volume; info/warn/error is enough.
  },
};

/** Every push to the renderer goes through "status"; src/main/updater/ipc.ts forwards it. */
export const updaterEvents = new EventEmitter();

function emit(status: UpdaterStatusEvent): void {
  updaterEvents.emit("status", status);
}

let latestKnownRelease: LatestReleaseInfo | null = null;
let currentCancellationToken: InstanceType<typeof CancellationToken> | null = null;
let cancelledByUser = false;
let isMandatoryFlow = false;
let downloadRetryCount = 0;
const MAX_DOWNLOAD_RETRIES = 3;

function backupRoot(): string {
  return path.join(app.getPath("userData"), "update-backups");
}
function pendingMarkerPath(): string {
  return path.join(app.getPath("userData"), "pending-update.json");
}
function failedMarkerPath(): string {
  return path.join(app.getPath("userData"), "update-failed.json");
}

// electron-vite bundles main into out/main/index.js, so __dirname is out/main/.
function watchdogScriptPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "updater-watchdog.ps1")
    : path.join(__dirname, "../../resources/updater-watchdog.ps1");
}

/** Deletes every existing backup before a new one is made — "keep only the most recent" bounded to one directory's worth of disk. */
async function pruneAllBackups(): Promise<void> {
  try {
    const root = backupRoot();
    const entries = await readdir(root, { withFileTypes: true });
    await Promise.all(entries.map((entry) => rm(path.join(root, entry.name), { recursive: true, force: true })));
  } catch {
    // No backups directory yet (first-ever update on this machine) — nothing to prune.
  }
}

async function primeElectronUpdater(): Promise<void> {
  try {
    // Hits the YAML feed (electron-builder.yml's `publish` block) so
    // electron-updater's own updateInfo is warm by the time the user clicks
    // "Update Now" — downloadUpdate() below needs it and would otherwise
    // have to do this same round trip synchronously at that point instead.
    await autoUpdater.checkForUpdates();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updaterLog.warn("electron-updater-check-failed", { message });
  }
}

/**
 * Reconciles the custom JSON endpoint (policy: is there something new, is
 * it mandatory) with electron-updater's own YAML-feed check (readiness: can
 * it actually be downloaded). The JSON response is what decides
 * mandatory/optional/no-op; electron-updater is purely the download/verify/
 * install engine from here on.
 */
export async function checkForUpdates(): Promise<CheckResult> {
  const currentVersion = app.getVersion();
  emit({ state: "check-started" });
  updaterLog.info("Update Check Started", { currentVersion });

  const release = await fetchLatestRelease(currentVersion);
  const checkedAt = new Date().toISOString();

  if (!release) {
    // Couldn't get a fresh answer (offline, timeout, server error, or
    // genuinely nothing published). Fall back to the cached policy: block
    // ONLY if this version is already known to be below a floor we
    // previously confirmed while online. A first-ever offline launch (no
    // cache yet) always allows.
    const cache = await readPolicyCache();
    if (shouldBlockOffline(currentVersion, cache)) {
      const knownMinimumVersion = cache.lastKnownMinimumVersion as string;
      emit({ state: "offline-blocked", currentVersion, knownMinimumVersion });
      return { status: "offline-blocked", currentVersion, knownMinimumVersion };
    }
    emit({ state: "check-failed", currentVersion });
    return { status: "check-failed", currentVersion };
  }

  latestKnownRelease = release;
  await updatePolicyCache({ lastKnownMinimumVersion: release.minimum_version, lastCheckAt: checkedAt });

  const mandatory = resolveMandatory(release, currentVersion);
  const hasNewer = isNewer(release.version, currentVersion);

  if (!hasNewer) {
    emit({ state: "no-update", currentVersion, checkedAt });
    return { status: "no-update", currentVersion };
  }

  await primeElectronUpdater();

  if (mandatory) {
    const reason = isBelowMinimum(currentVersion, release.minimum_version) ? "below_minimum" : "mandatory_flag";
    updaterLog.info("Update Available", { currentVersion, latestVersion: release.version, mandatory: true, reason });
    emit({
      state: "mandatory-required",
      currentVersion,
      latestVersion: release.version,
      releaseNotes: release.release_notes,
      reason,
      checkedAt,
    });
    return { status: "mandatory-required", currentVersion, latestVersion: release.version, releaseNotes: release.release_notes, reason };
  }

  const cache = await readPolicyCache();
  if (isDismissed(release.version, cache)) {
    // Suppressed re-nag — from the renderer's point of view this is
    // indistinguishable from "nothing new" until the ~24h window lapses.
    emit({ state: "no-update", currentVersion, checkedAt });
    return { status: "no-update", currentVersion };
  }

  updaterLog.info("Update Available", { currentVersion, latestVersion: release.version, mandatory: false });
  emit({
    state: "optional-available",
    currentVersion,
    latestVersion: release.version,
    releaseNotes: release.release_notes,
    checkedAt,
  });
  return { status: "optional-available", currentVersion, latestVersion: release.version, releaseNotes: release.release_notes };
}

function attemptDownload(): void {
  const token = new CancellationToken();
  currentCancellationToken = token;
  autoUpdater.downloadUpdate(token).catch((error) => {
    // A rejection here (as opposed to the "error" event below) is an
    // immediate/synchronous failure — e.g. cancelling before the first
    // byte arrives. Just log it; the "error" listener is what drives
    // retry/UI for the general case.
    const message = error instanceof Error ? error.message : String(error);
    updaterLog.warn("update-download-rejected", { message });
  });
}

/**
 * Starts (or restarts, from a manual retry) the download+install flow. Used
 * by both the renderer's "Update Now" button (optional) and the mandatory
 * flow's auto-trigger — mandatory-ness is recomputed HERE from the last
 * confirmed release, not trusted from whatever the renderer claims, so
 * cancelDownload() below can't be tricked into bypassing a mandatory update
 * by a caller that simply says "this one's optional."
 */
export function startUpdate(): { ok: true } | { ok: false; error: string } {
  if (!latestKnownRelease) {
    return { ok: false, error: "No update has been checked yet." };
  }
  const currentVersion = app.getVersion();
  isMandatoryFlow = resolveMandatory(latestKnownRelease, currentVersion);
  downloadRetryCount = 0;
  cancelledByUser = false;
  updaterLog.info("Update Download Started", { fromVersion: currentVersion, toVersion: latestKnownRelease.version });
  attemptDownload();
  return { ok: true };
}

/** Optional updates only — mandatory ones are never bypassable, per spec. */
export function cancelDownload(): boolean {
  if (isMandatoryFlow) return false;
  if (!currentCancellationToken) return false;
  cancelledByUser = true;
  currentCancellationToken.cancel();
  currentCancellationToken = null;
  emit({ state: "cancelled" });
  return true;
}

export async function dismissOptionalUpdate(version: string): Promise<void> {
  await updatePolicyCache({ lastDismissedVersion: version, lastDismissedAt: new Date().toISOString() });
}

export async function getState(): Promise<UpdaterState> {
  const cache = await readPolicyCache();
  return {
    currentVersion: app.getVersion(),
    lastCheckAt: cache.lastCheckAt,
    lastKnownMinimumVersion: cache.lastKnownMinimumVersion,
    latestKnownVersion: latestKnownRelease?.version ?? null,
  };
}

autoUpdater.on("download-progress", (progress) => {
  emit({
    state: "download-progress",
    percent: progress.percent,
    transferred: progress.transferred,
    total: progress.total,
    bytesPerSecond: progress.bytesPerSecond,
    mandatory: isMandatoryFlow,
  });
});

autoUpdater.on("update-downloaded", () => {
  const fromVersion = app.getVersion();
  const toVersion = latestKnownRelease?.version ?? "unknown";
  updaterLog.info("Update Download Completed", { fromVersion, toVersion });
  // electron-updater has already verified sha512 + blockmap internally
  // before firing this event (and emits "error" instead if that check
  // fails) — reaching here IS the checksum-verified state.
  updaterLog.info("Checksum Verified", { fromVersion, toVersion });
  currentCancellationToken = null;
  emit({ state: "downloaded" });
  // No separate "confirm install" step: by the time a download starts,
  // consent was already given (either the user clicked "Update Now", or
  // this is the non-bypassable mandatory flow) — proceed straight to
  // install, matching the spec's "Update Now" -> progress -> "installing,
  // app will restart" sequence with no extra click in between.
  void installAndRestart();
});

autoUpdater.on("error", (error) => {
  if (cancelledByUser) {
    // Expected: the user's own Cancel click surfacing as an "error" event
    // from electron-updater's internals, not a real failure.
    cancelledByUser = false;
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  updaterLog.error("Update Failed", { message, attempt: downloadRetryCount + 1 });

  if (downloadRetryCount < MAX_DOWNLOAD_RETRIES) {
    downloadRetryCount += 1;
    const attempt = downloadRetryCount;
    const backoffMs = attempt * 2000;
    emit({ state: "download-error", message, attempt, willRetry: true });
    setTimeout(() => {
      if (cancelledByUser || currentCancellationToken === null) return; // cancelled while waiting on backoff
      attemptDownload();
    }, backoffMs);
    return;
  }

  emit({ state: "download-error", message, attempt: downloadRetryCount + 1, willRetry: false });
  emit({ state: "error", message });
});

/**
 * Immediately before quitAndInstall(): backs up the current install
 * directory, writes the marker the watchdog and the next launch both read,
 * and spawns the detached watchdog — THEN quits into the NSIS silent
 * installer. Any failure in the backup/marker/spawn steps is logged but
 * does not block the install itself (see inline comment) — losing the
 * safety net for one update is recoverable; refusing to update at all over
 * it is not.
 */
export async function installAndRestart(): Promise<void> {
  const fromVersion = app.getVersion();
  const toVersion = latestKnownRelease?.version ?? "unknown";
  updaterLog.info("Old Version", { version: fromVersion });
  updaterLog.info("New Version", { version: toVersion });
  updaterLog.info("Installation Started", { fromVersion, toVersion });
  emit({ state: "installing" });

  try {
    // Per-user NSIS install (perMachine: false): dirname(exe) is the install root.
    const exePath = app.getPath("exe");
    const installDir = path.dirname(exePath);
    const backupPath = path.join(backupRoot(), fromVersion);

    await pruneAllBackups();
    await mkdir(path.dirname(backupPath), { recursive: true });
    await cp(installDir, backupPath, { recursive: true });

    const marker: PendingUpdateMarker = {
      fromVersion,
      toVersion,
      backupPath,
      mainExePath: exePath,
      timestamp: Date.now(),
    };
    await writeFile(pendingMarkerPath(), JSON.stringify(marker, null, 2));

    const watchdogPath = watchdogScriptPath();
    const child = spawn(
      "powershell.exe",
      [
        "-ExecutionPolicy",
        "Bypass",
        "-NoProfile",
        "-File",
        watchdogPath,
        "-OldPid",
        String(process.pid),
        "-NewExePath",
        exePath,
        "-BackupPath",
        backupPath,
        "-MainExePath",
        exePath,
        "-UserDataDir",
        app.getPath("userData"),
      ],
      { detached: true, stdio: "ignore", windowsHide: true },
    );
    child.unref();

    updaterLog.info("Updater Started", { fromVersion, toVersion, watchdogPid: child.pid ?? null });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updaterLog.error("Update Failed", { stage: "pre-install-backup", message });
    void postUpdateLog({ fromVersion, toVersion, status: "FAILED", stage: "pre-install-backup", message });
  }

  // isForceRunAfter=true: electron-updater relaunches the app itself once
  // the silent NSIS install finishes — that relaunch IS the "new process
  // comes up" event the watchdog is watching for. The watchdog only
  // verifies it stays healthy and restores the backup if it doesn't.
  autoUpdater.quitAndInstall(true, true);
}

async function handleLeftoverFailureMarker(mainWindow: BrowserWindow): Promise<void> {
  let marker: UpdateFailedMarker | null = null;
  try {
    const json = await readFile(failedMarkerPath(), "utf8");
    marker = JSON.parse(json) as UpdateFailedMarker;
  } catch {
    return; // No leftover marker — the common case on every normal launch.
  }

  await rm(failedMarkerPath(), { force: true }).catch(() => {});

  updaterLog.info("Rollback Completed", { fromVersion: marker.fromVersion, toVersion: marker.toVersion, reason: marker.reason });

  if (!mainWindow.isDestroyed()) {
    const event: UpdaterStatusEvent = {
      state: "restored-after-failure",
      fromVersion: marker.fromVersion,
      toVersion: marker.toVersion,
      reason: marker.reason,
    };
    mainWindow.webContents.send("updater:status", event);
  }

  void postUpdateLog({
    fromVersion: marker.fromVersion ?? undefined,
    toVersion: marker.toVersion ?? "unknown",
    status: "ROLLED_BACK",
    stage: "watchdog-restore",
    message: marker.reason ?? "Update failed verification; previous version was restored.",
  });
}

const PERIODIC_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
let periodicTimer: NodeJS.Timeout | null = null;

/**
 * A repeating setTimeout chain, not setInterval — a check that runs slow
 * (or a machine that sleeps mid-check) can never overlap the next one, since
 * the next timer is only scheduled after the current check settles. Gated
 * on the cached `lastCheckAt` so this never double-checks right behind a
 * manual "Check for Updates" click or the startup check that just ran.
 */
export function schedulePeriodicChecks(): void {
  if (periodicTimer) return; // Already scheduled — stay idempotent if called twice.

  const tick = async (): Promise<void> => {
    const cache = await readPolicyCache();
    const waitMs = cache.lastCheckAt
      ? Math.max(new Date(cache.lastCheckAt).getTime() + PERIODIC_CHECK_INTERVAL_MS - Date.now(), 0)
      : PERIODIC_CHECK_INTERVAL_MS; // Never checked successfully yet — the startup check just tried; don't hammer, wait a full interval.

    periodicTimer = setTimeout(() => {
      periodicTimer = null;
      checkForUpdates()
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          updaterLog.warn("periodic-check-failed", { message });
        })
        .finally(() => void tick());
    }, waitMs);
  };

  void tick();
}

/**
 * Called once, right after createWindow() in app.whenReady() — fire-and-
 * forget, must never block first paint. Order matters: a leftover
 * update-failed.json from a prior session's failed install is surfaced
 * FIRST (it describes something that already happened), then the normal
 * check runs, then the periodic timer is armed.
 */
export async function runStartupUpdateCheck(mainWindow: BrowserWindow): Promise<void> {
  updaterLog.info("Updater Started", { currentVersion: app.getVersion() });
  await handleLeftoverFailureMarker(mainWindow);
  await checkForUpdates().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    updaterLog.warn("startup-check-failed", { message });
  });
  schedulePeriodicChecks();
}
