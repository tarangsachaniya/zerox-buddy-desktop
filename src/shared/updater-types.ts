/** Updater shapes shared by main (src/main/updater) and the renderer (components/updater). */

/** The success-shaped body of GET /api/app-updates/latest (backend contract — do not rename fields). */
export type LatestReleaseInfo = {
  version: string;
  minimum_version: string;
  mandatory: boolean;
  download_url: string;
  checksum: string;
  file_size: number;
  release_date: string;
  release_notes: string[];
};

/** version-policy.ts's on-disk cache — userData/update-policy-cache.json. */
export type PolicyCache = {
  lastKnownMinimumVersion: string | null;
  /** ISO 8601. */
  lastCheckAt: string | null;
  lastDismissedVersion: string | null;
  /** ISO 8601. */
  lastDismissedAt: string | null;
};

/** Written by updater-service.ts's installAndRestart(), read back by resources/updater-watchdog.ps1. */
export type PendingUpdateMarker = {
  fromVersion: string;
  toVersion: string;
  backupPath: string;
  mainExePath: string;
  /** Epoch ms. */
  timestamp: number;
};

/** Written by resources/updater-watchdog.ps1 on a failed install, read back on the next app launch. */
export type UpdateFailedMarker = {
  fromVersion: string | null;
  toVersion: string | null;
  reason: string | null;
  /** Epoch ms. */
  timestamp: number;
};

/** POST /api/app-updates/log body (backend contract — do not rename fields). */
export type UpdateLogPayload = {
  deviceId?: string;
  fromVersion?: string;
  toVersion: string;
  status: "SUCCESS" | "FAILED" | "ROLLED_BACK";
  stage?: string;
  message?: string;
};

/**
 * Every shape updater-service.ts can push to the renderer over the
 * "updater:status" channel. The renderer's updater bridge switches on
 * `state` alone — nothing here carries a token, path, or anything else that
 * shouldn't cross into renderer-reachable memory.
 */
export type UpdaterStatusEvent =
  | { state: "check-started" }
  | { state: "check-failed"; currentVersion: string }
  | { state: "no-update"; currentVersion: string; checkedAt: string }
  | { state: "cancelled" }
  | {
      state: "optional-available";
      currentVersion: string;
      latestVersion: string;
      releaseNotes: string[];
      checkedAt: string;
    }
  | {
      state: "mandatory-required";
      currentVersion: string;
      latestVersion: string;
      releaseNotes: string[];
      reason: "mandatory_flag" | "below_minimum";
      checkedAt: string;
    }
  | { state: "offline-blocked"; currentVersion: string; knownMinimumVersion: string }
  | {
      state: "download-progress";
      percent: number;
      transferred: number;
      total: number;
      bytesPerSecond: number;
      /** Whether THIS download is the non-bypassable mandatory flow — the renderer uses it to decide whether Cancel is even shown. */
      mandatory: boolean;
    }
  | { state: "downloaded" }
  | { state: "installing" }
  | { state: "download-error"; message: string; attempt: number; willRetry: boolean }
  | { state: "error"; message: string }
  | { state: "restored-after-failure"; fromVersion: string | null; toVersion: string | null; reason: string | null };

/** Resolved policy decision returned by updater-service.ts's checkForUpdates() — what "updater:check" hands back to the renderer. */
export type CheckResult =
  | { status: "no-update"; currentVersion: string }
  | { status: "optional-available"; currentVersion: string; latestVersion: string; releaseNotes: string[] }
  | {
      status: "mandatory-required";
      currentVersion: string;
      latestVersion: string;
      releaseNotes: string[];
      reason: "mandatory_flag" | "below_minimum";
    }
  | { status: "offline-blocked"; currentVersion: string; knownMinimumVersion: string }
  | { status: "check-failed"; currentVersion: string };

export type UpdaterState = {
  currentVersion: string;
  lastCheckAt: string | null;
  lastKnownMinimumVersion: string | null;
  latestKnownVersion: string | null;
};
