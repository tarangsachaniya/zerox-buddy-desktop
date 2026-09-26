import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { DetectedPrinter, PaperSize, PrinterStatus } from "../../shared/types";
import { INCLUDE_VIRTUAL_PRINTERS } from "../config";
import { log } from "../log";

const execFileAsync = promisify(execFile);

/**
 * Windows printers this computer can print documents on, with what their
 * drivers say they can do. One PowerShell call: Get-Printer for the list and
 * status, .NET PrinterSettings for color, duplex and paper sizes.
 *
 * Drivers often over-report (mono lasers commonly claim color), which is why
 * the owner can override capabilities; the server keeps overrides across
 * later detections.
 *
 * Filtered out: virtual printers (PDF, XPS, fax, remote-desktop, AnyDesk…)
 * and receipt printers (no A4 or A3 paper), so neither can take one of the
 * plan's printer slots. execFile with the absolute powershell.exe path, as in
 * priinteve-owner-desktop (spawn was seen to hang inside Electron).
 */

const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

const SCRIPT = `
Add-Type -AssemblyName System.Drawing
$rows = foreach ($p in Get-Printer) {
  $s = New-Object System.Drawing.Printing.PrinterSettings
  $s.PrinterName = $p.Name
  $kinds = @()
  if ($s.IsValid) { $kinds = @($s.PaperSizes | ForEach-Object { [string]$_.Kind } | Select-Object -Unique) }
  [PSCustomObject]@{
    Name = $p.Name; DriverName = $p.DriverName; PrinterStatus = [int]$p.PrinterStatus
    WorkOffline = [bool]$p.WorkOffline; Valid = $s.IsValid
    Color = $s.SupportsColor; Duplex = $s.CanDuplex; Kinds = $kinds
  }
}
@($rows) | ConvertTo-Json -Compress -Depth 3
`;

type Row = {
  Name: string;
  DriverName: string | null;
  PrinterStatus: number;
  WorkOffline: boolean;
  Valid: boolean;
  Color: boolean;
  Duplex: boolean;
  Kinds: string[] | string | null;
};

const VIRTUAL = [/\bpdf\b/i, /\bxps\b/i, /\bfax\b/i, /onenote/i, /anydesk/i, /remote desktop/i, /redirected/i, /citrix/i, /teamviewer/i, /generic \/ text only/i];

function isVirtual(name: string, driver: string): boolean {
  return VIRTUAL.some((re) => re.test(name) || re.test(driver));
}

/**
 * MSFT_Printer PrinterStatus. Only values we're confident about get a
 * specific meaning; anything else is treated as ready rather than guessed.
 */
function mapStatus(code: number, workOffline: boolean): { status: PrinterStatus; statusMessage?: string } {
  if (workOffline) return { status: "OFFLINE", statusMessage: "Set to use offline in Windows" };
  switch (code) {
    case 1:
      return { status: "ERROR", statusMessage: "Paused in Windows" };
    case 2:
      return { status: "ERROR", statusMessage: "Printer error" };
    case 4:
      return { status: "ERROR", statusMessage: "Paper jam" };
    case 5:
      return { status: "ERROR", statusMessage: "Out of paper" };
    case 7:
      return { status: "ERROR", statusMessage: "Paper problem" };
    case 8:
    case 13:
      return { status: "OFFLINE", statusMessage: "Printer is offline" };
    case 19:
      return { status: "ERROR", statusMessage: "Out of toner or ink" };
    case 23:
      return { status: "ERROR", statusMessage: "Door open" };
    case 10:
    case 11:
      return { status: "BUSY" };
    default:
      return { status: "ONLINE" };
  }
}

export function toDetected(rows: Row[]): DetectedPrinter[] {
  const out: DetectedPrinter[] = [];
  for (const r of rows) {
    if (!r?.Name) continue;
    if (!INCLUDE_VIRTUAL_PRINTERS && isVirtual(r.Name, r.DriverName ?? "")) continue;
    const kinds = Array.isArray(r.Kinds) ? r.Kinds : r.Kinds ? [r.Kinds] : [];
    const paperSizes = (["A4", "A3"] as PaperSize[]).filter((k) => kinds.includes(k));
    if (paperSizes.length === 0) continue; // receipt / label printer
    out.push({
      systemName: r.Name,
      supportsColor: !!r.Color,
      supportsDuplex: !!r.Duplex,
      paperSizes,
      ...mapStatus(r.PrinterStatus, r.WorkOffline),
    });
  }
  return out;
}

export async function detectPrinters(): Promise<DetectedPrinter[]> {
  if (process.platform !== "win32") return [];
  try {
    const { stdout } = await execFileAsync(POWERSHELL, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SCRIPT], {
      timeout: 20_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (!stdout.trim()) return [];
    const parsed = JSON.parse(stdout) as Row | Row[];
    return toDetected(Array.isArray(parsed) ? parsed : [parsed]);
  } catch (err) {
    log.error("[discovery] printer query failed", err);
    throw new Error("Couldn't read the printers on this computer.");
  }
}
