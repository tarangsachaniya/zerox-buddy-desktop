import { app } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import semver from "semver";

import type { LatestReleaseInfo, PolicyCache } from "./types";

/**
 * Never plain string comparison (see LatestReleaseInfo — "1.9.0" < "1.10.0"
 * lexically would say the opposite of what's true). `semver.coerce` covers
 * a version that arrives without full x.y.z shape; both isNewer() and
 * isBelowMinimum() return false (never throw) on anything semver can't
 * parse, since "not clearly newer/below" is the safe default for a
 * comparison this decision-critical.
 */
export function isNewer(latest: string, current: string): boolean {
  const l = semver.valid(semver.coerce(latest));
  const c = semver.valid(semver.coerce(current));
  if (!l || !c) return false;
  return semver.gt(l, c);
}

export function isBelowMinimum(current: string, minVersion: string): boolean {
  const c = semver.valid(semver.coerce(current));
  const m = semver.valid(semver.coerce(minVersion));
  if (!c || !m) return false;
  return semver.lt(c, m);
}

/** `release.mandatory` alone isn't enough — a floor-raise (minimum_version bumped) must also force an update even if this specific release wasn't flagged mandatory. */
export function resolveMandatory(release: LatestReleaseInfo, currentVersion: string): boolean {
  return release.mandatory || isBelowMinimum(currentVersion, release.minimum_version);
}

const DEFAULT_CACHE: PolicyCache = {
  lastKnownMinimumVersion: null,
  lastCheckAt: null,
  lastDismissedVersion: null,
  lastDismissedAt: null,
};

function cachePath(): string {
  return path.join(app.getPath("userData"), "update-policy-cache.json");
}

export async function readPolicyCache(): Promise<PolicyCache> {
  try {
    const json = await readFile(cachePath(), "utf8");
    return { ...DEFAULT_CACHE, ...(JSON.parse(json) as Partial<PolicyCache>) };
  } catch {
    // No file yet (first-ever launch) or corrupt contents — either way, the
    // safe default is "nothing known yet," which never blocks offline use.
    return { ...DEFAULT_CACHE };
  }
}

export async function writePolicyCache(next: PolicyCache): Promise<void> {
  try {
    await mkdir(path.dirname(cachePath()), { recursive: true });
    await writeFile(cachePath(), JSON.stringify(next, null, 2));
  } catch {
    // Best-effort only — losing this write degrades to "always allow
    // offline use" on the next launch, never to a crash.
  }
}

export async function updatePolicyCache(patch: Partial<PolicyCache>): Promise<PolicyCache> {
  const current = await readPolicyCache();
  const next: PolicyCache = { ...current, ...patch };
  await writePolicyCache(next);
  return next;
}

/**
 * Spec: "if update-check fails while offline AND currentVersion is already
 * below a previously-confirmed minimum_version, block; otherwise allow
 * offline use." A first-ever offline launch (no cache, `lastKnownMinimumVersion`
 * still null) always allows — there is nothing "previously confirmed" yet.
 */
export function shouldBlockOffline(currentVersion: string, cache: PolicyCache): boolean {
  if (!cache.lastKnownMinimumVersion) return false;
  return isBelowMinimum(currentVersion, cache.lastKnownMinimumVersion);
}

const DISMISS_WINDOW_MS = 24 * 60 * 60 * 1000;

/** "Remind Me Later" suppression — same version only, ~24h, never applies to a mandatory update. */
export function isDismissed(version: string, cache: PolicyCache, windowMs = DISMISS_WINDOW_MS): boolean {
  if (cache.lastDismissedVersion !== version || !cache.lastDismissedAt) return false;
  return Date.now() - new Date(cache.lastDismissedAt).getTime() < windowMs;
}
