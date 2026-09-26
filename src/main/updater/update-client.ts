import { API_BASE_URL, UPDATE_PLATFORM } from "../config";
import { updaterLog } from "./logger";
import type { LatestReleaseInfo, UpdateLogPayload } from "./types";

type LatestReleaseResponse = ({ success: true } & LatestReleaseInfo) | { success: false; error: string };

// No bearer token: /api/app-updates resolves restaurant (VentaDot) device
// sessions for telemetry, which a Zerox token never is. The check has to work
// signed out anyway.
async function fetchOnce(currentVersion: string): Promise<Response> {
  const url = `${API_BASE_URL}/api/app-updates/latest?platform=${UPDATE_PLATFORM}&channel=stable&currentVersion=${encodeURIComponent(currentVersion)}`;
  return fetch(url, { headers: { "X-App-Version": currentVersion }, signal: AbortSignal.timeout(10_000) });
}

/**
 * Never throws: offline, timeout, non-2xx, bad JSON and "no_published_release"
 * all collapse to null. One retry, on a network error only.
 */
export async function fetchLatestRelease(currentVersion: string): Promise<LatestReleaseInfo | null> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetchOnce(currentVersion);
      if (!res.ok) {
        updaterLog.warn("update-check-http-error", { status: res.status, attempt });
        return null;
      }
      const body = (await res.json()) as LatestReleaseResponse;
      if (!body.success) return null;
      const { success: _success, ...release } = body;
      return release;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updaterLog.warn("update-check-network-error", { attempt, message });
    }
  }
  return null;
}

/** Fire-and-forget telemetry; callers `void` it. */
export async function postUpdateLog(payload: UpdateLogPayload): Promise<void> {
  try {
    await fetch(`${API_BASE_URL}/api/app-updates/log`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-App-Version": payload.toVersion },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // best-effort
  }
}
