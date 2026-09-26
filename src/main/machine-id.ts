import { app } from "electron";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A random id per install, so signing in again on the same computer reuses
 * its device row (and printer settings) instead of creating a new one.
 * Not a hardware fingerprint on purpose: nothing about the machine leaves it.
 */
let cached: string | null = null;

export function machineId(): string {
  if (cached) return cached;
  const file = join(app.getPath("userData"), "machine-id");
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (/^[A-Za-z0-9_-]{8,64}$/.test(existing)) return (cached = existing);
  } catch {
    // first run
  }
  cached = randomUUID();
  writeFileSync(file, cached);
  return cached;
}
