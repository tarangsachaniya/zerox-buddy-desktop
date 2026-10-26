import { app } from "electron";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { CounterOrder } from "../../shared/types";
import { ApiError, deviceRequest } from "../auth/api-client";
import { getSession } from "../auth/token-store";
import { log } from "../log";

/**
 * Scans and photocopies waiting to be recorded as orders on the server.
 * Saved to disk before anything else happens, so an order made offline (or
 * just before a crash) is never lost; synced in order, one at a time. The
 * server is idempotent on clientRef, so a sync whose response was lost is
 * simply sent again.
 *
 * Each entry remembers the shop it belongs to: after signing in to another
 * shop on this computer, the first shop's orders wait for it.
 */

type Stored = CounterOrder & { shopId: string };

type Recorded = { id: string; specimenNo: number | null; specimenRef: string | null; amount: number };

function file(): string {
  return join(app.getPath("userData"), "counter-orders.json");
}

function read(): Stored[] {
  try {
    return JSON.parse(readFileSync(file(), "utf8")) as Stored[];
  } catch {
    return [];
  }
}

/** Atomic: write a temp file, then rename over the old one. */
function write(entries: Stored[]): void {
  const tmp = `${file()}.tmp`;
  writeFileSync(tmp, JSON.stringify(entries));
  renameSync(tmp, file());
}

/** This shop's waiting orders, for the Scan screen. */
export function pendingOrders(): CounterOrder[] {
  const shopId = getSession()?.shop.id;
  return read()
    .filter((e) => e.shopId === shopId)
    .map(({ shopId: _, ...order }) => order);
}

export function addOrder(order: CounterOrder): void {
  const shopId = getSession()?.shop.id;
  if (!shopId) throw new Error("Sign in first");
  write([...read(), { ...order, shopId }]);
}

/** Moves a saved scan to its specimen name once recorded; keeps the old name if that fails. */
function renameScan(path: string, specimenRef: string): string {
  const target = join(dirname(path), `${specimenRef}.pdf`);
  if (path === target || existsSync(target)) return path;
  try {
    renameSync(path, target);
    return target;
  } catch (err) {
    log.warn("[outbox] couldn't rename the scan", err instanceof Error ? err.message : err);
    return path;
  }
}

let syncing: Promise<void> | null = null;

/**
 * Records every waiting order of the signed-in shop. Stops at the first
 * network failure (the rest would fail too); a refusal (e.g. no scan price
 * set) is kept with its reason and retried next time.
 */
export function syncOrders(onRecorded?: (order: CounterOrder, recorded: Recorded & { savedPath?: string }) => void): Promise<void> {
  syncing ??= (async () => {
    try {
      const shopId = getSession()?.shop.id;
      if (!shopId) return;
      for (const entry of read().filter((e) => e.shopId === shopId)) {
        const { shopId: _, savedPath, error: __, ...body } = entry;
        try {
          const { job } = await deviceRequest<{ job: Recorded }>("/counter-jobs", { method: "POST", body });
          const finalPath = savedPath && job.specimenRef ? renameScan(savedPath, job.specimenRef) : savedPath;
          write(read().filter((e) => e.clientRef !== entry.clientRef));
          log.info(`[outbox] ${entry.kind} recorded as #${job.specimenNo}`);
          onRecorded?.(entry, { ...job, savedPath: finalPath });
        } catch (err) {
          const status = err instanceof ApiError ? err.status : 0;
          if (status === 0 || status >= 500 || status === 401) return; // offline or server trouble: later
          const reason = err instanceof Error ? err.message : "Refused";
          write(read().map((e) => (e.clientRef === entry.clientRef ? { ...e, error: reason } : e)));
          log.warn(`[outbox] ${entry.kind} ${entry.clientRef} refused`, reason);
        }
      }
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}
