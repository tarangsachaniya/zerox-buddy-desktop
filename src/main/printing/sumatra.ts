import { app } from "electron";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { log } from "../log";

/**
 * Silent printing through the bundled, unmodified SumatraPDF (GPLv3, see
 * resources/SumatraPDF-LICENSE.txt). One process per file; it hands the
 * document to the Windows spooler and exits. Works for PDF, JPG and PNG.
 *
 * "Success" here means the spooler accepted the job — the same point a
 * person pressing Print would consider it sent.
 */

const PRINT_TIMEOUT_MS = 3 * 60 * 1000;

export function sumatraPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "SumatraPDF.exe")
    : join(__dirname, "../../resources/SumatraPDF.exe");
}

export function sumatraAvailable(): boolean {
  return existsSync(sumatraPath());
}

export function printWithSumatra(filePath: string, printerName: string, settings: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ["-print-to", printerName, "-print-settings", settings, "-silent", filePath];
    execFile(sumatraPath(), args, { timeout: PRINT_TIMEOUT_MS, windowsHide: true }, (err) => {
      if (err) {
        log.error("[print] SumatraPDF failed", { printerName, settings, code: (err as NodeJS.ErrnoException).code });
        reject(new Error(err.killed ? "The printer took too long to accept the job" : "The printer didn't accept the job"));
        return;
      }
      resolve();
    });
  });
}

/** Opens a document in SumatraPDF's viewer, for "Preview before printing". */
export function openInViewer(filePath: string): void {
  execFile(sumatraPath(), ["-reuse-instance", filePath], { windowsHide: false }, (err) => {
    if (err && !(err as { killed?: boolean }).killed) log.warn("[print] viewer closed with error", err.message);
  });
}
