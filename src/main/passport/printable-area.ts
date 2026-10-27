import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { Margins } from "../../shared/passport/layout";
import { log } from "../log";

const execFileAsync = promisify(execFile);

/**
 * Where on the paper a printer can actually put ink, for a passport sheet's
 * paper: Windows' hard margins (portrait, in mm). The layout never puts a
 * photo inside them, and the print PDF is shifted back by the left/top ones so
 * SumatraPDF's `noscale` lands it at its true position.
 *
 * Read with .NET PageSettings for the paper that matches the size (drivers
 * name 4×6 in a dozen ways, so it's matched by dimensions, not by name).
 * Inputs go through environment variables. Null when Windows can't say; the
 * caller then keeps a safe minimum margin and warns the operator.
 */

const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

const SCRIPT = `
Add-Type -AssemblyName System.Drawing
$s = New-Object System.Drawing.Printing.PrinterSettings
$s.PrinterName = $env:ZX_PRINTER
if (-not $s.IsValid) { '{"found":false}'; exit }
$w = [int]$env:ZX_W; $h = [int]$env:ZX_H
$match = $s.PaperSizes | Where-Object { ([Math]::Abs($_.Width - $w) -le 4 -and [Math]::Abs($_.Height - $h) -le 4) -or ([Math]::Abs($_.Width - $h) -le 4 -and [Math]::Abs($_.Height - $w) -le 4) } | Select-Object -First 1
if (-not $match) { '{"found":false}'; exit }
$pg = New-Object System.Drawing.Printing.PageSettings($s)
$pg.PaperSize = $match
$pg.Landscape = $false
$a = $pg.PrintableArea
[PSCustomObject]@{ found = $true; name = $match.PaperName; w = $match.Width; h = $match.Height; x = $a.X; y = $a.Y; aw = $a.Width; ah = $a.Height } | ConvertTo-Json -Compress
`;

/** Hundredths of an inch, as .NET reports them. */
export type AreaRow = { found: boolean; name?: string; w?: number; h?: number; x?: number; y?: number; aw?: number; ah?: number };

export type PrintableArea = { paperName: string; hardMargins: Margins };

const MM_PER_HUNDREDTH_INCH = 0.254;
/** More than this on any side means the driver's answer is nonsense. */
const MAX_SANE_MARGIN_MM = 25;

/** PowerShell's row → portrait hard margins in mm. Pure. */
export function toPrintableArea(row: AreaRow): PrintableArea | null {
  if (!row.found) return null;
  const nums = [row.w, row.h, row.x, row.y, row.aw, row.ah];
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)) return null;
  let [w, h, x, y, aw, ah] = nums as number[];
  // Some drivers report the paper landscape even with Landscape = false.
  if (w > h) {
    [w, h] = [h, w];
    [x, y] = [y, x];
    [aw, ah] = [ah, aw];
  }
  const round = (n: number) => Math.round(Math.max(0, n) * MM_PER_HUNDREDTH_INCH * 100) / 100;
  const hardMargins: Margins = { left: round(x), top: round(y), right: round(w - x - aw), bottom: round(h - y - ah) };
  if (Object.values(hardMargins).some((m) => m > MAX_SANE_MARGIN_MM)) return null;
  return { paperName: row.name ?? "", hardMargins };
}

const cache = new Map<string, PrintableArea | null>();

export async function getPrintableArea(systemName: string, paper: { widthMm: number; heightMm: number }): Promise<PrintableArea | null> {
  const w = Math.round(Math.min(paper.widthMm, paper.heightMm) / MM_PER_HUNDREDTH_INCH);
  const h = Math.round(Math.max(paper.widthMm, paper.heightMm) / MM_PER_HUNDREDTH_INCH);
  const key = `${systemName}|${w}x${h}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  let area: PrintableArea | null = null;
  try {
    const { stdout } = await execFileAsync(POWERSHELL, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SCRIPT], {
      env: { ...process.env, ZX_PRINTER: systemName, ZX_W: String(w), ZX_H: String(h) },
      windowsHide: true,
      timeout: 20_000,
    });
    area = toPrintableArea(JSON.parse(stdout.trim()) as AreaRow);
  } catch (err) {
    log.warn(`[passport] printable area for ${systemName}`, err instanceof Error ? err.message : err);
  }
  cache.set(key, area);
  return area;
}

/** Forget what was read, e.g. after the operator changed the printer's preferences. */
export function clearPrintableAreaCache(): void {
  cache.clear();
}
