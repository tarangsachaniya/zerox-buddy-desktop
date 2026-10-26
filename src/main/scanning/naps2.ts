import { app } from "electron";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { ScanDriver, ScanMode, ScanSource, Scanner } from "../../shared/types";
import { log } from "../log";

/**
 * Scanning through the bundled, unmodified NAPS2 console (GPLv2, see
 * resources/NAPS2-LICENSE.txt), one process per scan. It speaks WIA, TWAIN
 * and eSCL (network AirScan), so it reaches nearly every all-in-one printer's
 * scanner with the driver Windows already has. x64 only: on a 32-bit install
 * the folder is empty and Scan is hidden.
 *
 * Each scan writes one JPEG per page into a folder we own; the caller reads
 * them back in page order.
 */

const LIST_TIMEOUT_MS = 60_000;
/** A full feeder at 300 dpi can take minutes. */
const SCAN_TIMEOUT_MS = 10 * 60 * 1000;
/** WIA is the most reliable on Windows; eSCL reaches network scanners with no driver; TWAIN last. */
const DRIVERS: ScanDriver[] = ["wia", "escl", "twain"];

export function naps2Path(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "naps2", "App", "NAPS2.Console.exe")
    : join(__dirname, "../../resources/naps2", process.arch, "App", "NAPS2.Console.exe");
}

export function scanningAvailable(): boolean {
  return existsSync(naps2Path());
}

function runNaps2(args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(naps2Path(), args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = `${String(stdout)}\n${String(stderr)}`.trim();
      if (err) {
        log.warn("[scan] NAPS2 failed", { args: args.filter((a) => !a.includes("\\")), code: (err as NodeJS.ErrnoException).code, out: out.slice(0, 2000) });
        const reason = err.killed ? "The scanner took too long" : lastLine(out) || "The scanner didn't respond";
        reject(new Error(reason));
        return;
      }
      resolve(out);
    });
  });
}

function lastLine(text: string): string {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
}

/** Pure. `--listdevices` prints one device name per line. */
export function parseDeviceList(output: string): string[] {
  return [...new Set(output.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^(error|warning|usage)\b/i.test(l)))];
}

/**
 * Every scanner any driver can see. The same device often shows up under
 * several drivers; it's listed once, under the first that sees it (DRIVERS
 * order). A driver that fails (e.g. no TWAIN DSM) is skipped, not fatal.
 */
export async function listScanners(): Promise<Scanner[]> {
  const seen = new Set<string>();
  const out: Scanner[] = [];
  for (const driver of DRIVERS) {
    let names: string[];
    try {
      names = parseDeviceList(await runNaps2(["--listdevices", "--driver", driver], LIST_TIMEOUT_MS));
    } catch {
      continue;
    }
    for (const name of names) {
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: `${driver}:${name}`, driver, name });
    }
  }
  log.info(`[scan] found ${out.length} scanner(s)`, out.map((s) => s.id));
  return out;
}

export type ScanRequest = {
  scanner: Scanner;
  source: ScanSource;
  mode: ScanMode;
  dpi: number;
  /** NAPS2 --pagesize: "a4", "a3", or "<w>x<h> mm" for an ID card corner. */
  pageSize: string;
};

/** Scans into `dir` (which must be empty) and returns the page images in order. */
export async function scanPages(req: ScanRequest, dir: string): Promise<string[]> {
  const args = [
    "--noprofile",
    "--driver", req.scanner.driver,
    "--device", req.scanner.name,
    "--source", req.source,
    "--bitdepth", req.mode,
    "--dpi", String(req.dpi),
    "--pagesize", req.pageSize,
    "--jpegquality", "90",
    "-o", join(dir, "page-$(nnnn).jpg"),
    "--force",
    "--verbose",
  ];
  const out = await runNaps2(args, SCAN_TIMEOUT_MS);
  const files = (await readdir(dir)).filter((f) => /\.jpe?g$/i.test(f)).sort();
  if (files.length === 0) {
    const said = lastLine(out);
    throw new Error(req.source === "glass" ? said || "Nothing was scanned" : "No pages came through. Is the paper in the feeder?");
  }
  return files.map((f) => join(dir, f));
}
