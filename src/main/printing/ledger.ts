import { app } from "electron";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * This computer's record of what it sent to printers, written before and
 * after each spooler hand-off (spec §67). After a crash or power cut it's
 * what decides between "it printed, report done" and "it may have printed,
 * ask a person" — never a silent second print.
 *
 *   printing  about to hand pages to the spooler (outcome unknown after a crash)
 *   sent      the spooler accepted every file
 */

export type LedgerEntry = { jobId: string; printerId: string; phase: "printing" | "sent"; at: string };

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function file(): string {
  return join(app.getPath("userData"), "print-ledger.json");
}

function read(): Record<string, LedgerEntry> {
  try {
    return JSON.parse(readFileSync(file(), "utf8")) as Record<string, LedgerEntry>;
  } catch {
    return {};
  }
}

/** Atomic: write a temp file, then rename over the old one. */
function write(entries: Record<string, LedgerEntry>): void {
  const cutoff = Date.now() - MAX_AGE_MS;
  const kept = Object.fromEntries(Object.entries(entries).filter(([, e]) => new Date(e.at).getTime() > cutoff));
  const tmp = `${file()}.tmp`;
  writeFileSync(tmp, JSON.stringify(kept));
  renameSync(tmp, file());
}

export function recordPhase(attemptId: string, entry: Omit<LedgerEntry, "at">): void {
  const all = read();
  all[attemptId] = { ...entry, at: new Date().toISOString() };
  write(all);
}

export function lookup(attemptId: string): LedgerEntry | null {
  return read()[attemptId] ?? null;
}

export function forget(attemptId: string): void {
  const all = read();
  if (!(attemptId in all)) return;
  delete all[attemptId];
  write(all);
}
