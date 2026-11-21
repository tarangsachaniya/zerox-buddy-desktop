import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { LocationReading } from "../shared/types";
import { log } from "./log";

const execFileAsync = promisify(execFile);

/**
 * This computer's position from Windows Location (Wi-Fi / IP based on most
 * shop PCs, so often ±50–500 m), for the required "Shop location" step. Read
 * through .NET GeoCoordinateWatcher in PowerShell: no API key, and the same
 * Windows setting the owner can switch on (Settings → Privacy → Location).
 * The Store (MSIX) build declares the `location` capability for this.
 */

const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Device
$w = New-Object System.Device.Location.GeoCoordinateWatcher([System.Device.Location.GeoPositionAccuracy]::High)
$w.Start($true)
$deadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $deadline) {
  if ($w.Permission -eq 'Denied' -or $w.Status -eq 'Disabled') { break }
  if ($w.Status -eq 'Ready' -and -not $w.Position.Location.IsUnknown) { break }
  Start-Sleep -Milliseconds 250
}
$loc = $w.Position.Location
$o = [ordered]@{ status = "$($w.Status)"; permission = "$($w.Permission)" }
if (-not $loc.IsUnknown) { $o.lat = $loc.Latitude; $o.lng = $loc.Longitude; $o.accuracy = $loc.HorizontalAccuracy }
$w.Stop()
$o | ConvertTo-Json -Compress
`;

export type WatcherRow = { status?: string; permission?: string; lat?: number; lng?: number; accuracy?: number };

/** PowerShell's row → a reading or why there isn't one. Pure. */
export function toLocationReading(row: WatcherRow): LocationReading {
  const { lat, lng, accuracy } = row;
  if (
    typeof lat === "number" && typeof lng === "number" &&
    Number.isFinite(lat) && Number.isFinite(lng) &&
    Math.abs(lat) <= 90 && Math.abs(lng) <= 180 &&
    !(lat === 0 && lng === 0)
  ) {
    return { ok: true, lat, lng, accuracy: typeof accuracy === "number" && Number.isFinite(accuracy) ? Math.round(accuracy) : null };
  }
  if (row.permission === "Denied") return { ok: false, reason: "denied" };
  if (row.status === "Disabled") return { ok: false, reason: "off" };
  return { ok: false, reason: "unavailable" };
}

export async function readComputerLocation(): Promise<LocationReading> {
  try {
    const { stdout } = await execFileAsync(POWERSHELL, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SCRIPT], {
      windowsHide: true,
      timeout: 25_000,
    });
    const reading = toLocationReading(JSON.parse(stdout.trim()) as WatcherRow);
    // Never log the coordinates themselves.
    log.info(`[location] ${reading.ok ? `read (±${reading.accuracy ?? "?"} m)` : reading.reason}`);
    return reading;
  } catch (err) {
    log.warn("[location] couldn't read Windows location", err);
    return { ok: false, reason: "unavailable" };
  }
}
