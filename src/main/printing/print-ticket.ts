import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { PrintCapabilities, PrintTicketOptions, PrintResolution } from "../../shared/types";
import { log } from "../log";

const execFileAsync = promisify(execFile);

/**
 * The settings Ctrl+P → Preferences would change (paper type, print quality,
 * resolution) for prints made at the counter. SumatraPDF has no switch for
 * them; it prints with the printer's per-user default ticket, so that ticket
 * is set just before the print and put back right after. Both happen inside
 * the printer's chain in processor.ts, so a customer job never prints with a
 * counter print's settings.
 *
 * Windows' System.Printing does the work (PrintQueue.GetPrintCapabilities,
 * UserPrintTicket). Inputs go in through environment variables, never into
 * the script text. Drivers differ wildly; anything that fails is logged and
 * the print goes ahead with the printer's own settings.
 */

const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

const FIND_QUEUE = `
Add-Type -AssemblyName System.Printing
$srv = New-Object System.Printing.LocalPrintServer
$types = @([System.Printing.EnumeratedPrintQueueTypes]::Local, [System.Printing.EnumeratedPrintQueueTypes]::Connections)
$q = $srv.GetPrintQueues($types) | Where-Object { $_.FullName -eq $env:ZX_PRINTER -or $_.Name -eq $env:ZX_PRINTER } | Select-Object -First 1
if (-not $q) { '{"ok":false,"error":"Printer not found"}'; exit }
`;

/**
 * Native helpers. Many drivers (HP, Epson, Canon) list their paper types —
 * "Plain paper", "HP Advanced Photo Paper, glossy" — only in the old GDI
 * list (DeviceCapabilities DC_MEDIATYPES / DC_MEDIATYPENAMES, DEVMODE
 * dmMediaType), not in Windows' standard print-ticket list.
 */
const NATIVE = `
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName ReachFramework
if (-not ('ZX.W' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace ZX {
  public static class W {
    [DllImport("winspool.drv", EntryPoint = "DeviceCapabilitiesW", CharSet = CharSet.Unicode)]
    public static extern int DeviceCapabilities(string device, string port, ushort capability, IntPtr output, IntPtr devMode);
    [DllImport("kernel32.dll")] public static extern IntPtr GlobalLock(IntPtr h);
    [DllImport("kernel32.dll")] public static extern bool GlobalUnlock(IntPtr h);
    [DllImport("kernel32.dll")] public static extern IntPtr GlobalFree(IntPtr h);
  }
}
'@
}
function ZxDevmodeBytes($ps, $pg) {
  $hdm = $ps.GetHdevmode($pg)
  $ptr = [ZX.W]::GlobalLock($hdm)
  try {
    $size = [Runtime.InteropServices.Marshal]::ReadInt16($ptr, 68) + [Runtime.InteropServices.Marshal]::ReadInt16($ptr, 70)
    $bytes = New-Object byte[] $size
    [Runtime.InteropServices.Marshal]::Copy($ptr, $bytes, 0, $size)
    return ,$bytes
  } finally {
    [void][ZX.W]::GlobalUnlock($hdm)
    [void][ZX.W]::GlobalFree($hdm)
  }
}
`;

const CAPS_SCRIPT = `${FIND_QUEUE}${NATIVE}
$c = $q.GetPrintCapabilities()
$t = $q.UserPrintTicket
$dm = @()
$dmCurrent = 0
try {
  $port = $null
  try { $port = $q.QueuePort.Name } catch { }
  $n = [ZX.W]::DeviceCapabilities($q.FullName, $port, 35, [IntPtr]::Zero, [IntPtr]::Zero)
  if ($n -gt 0 -and $n -lt 500) {
    $ids = [Runtime.InteropServices.Marshal]::AllocHGlobal($n * 4)
    $names = [Runtime.InteropServices.Marshal]::AllocHGlobal($n * 128)
    try {
      [void][ZX.W]::DeviceCapabilities($q.FullName, $port, 35, $ids, [IntPtr]::Zero)
      [void][ZX.W]::DeviceCapabilities($q.FullName, $port, 34, $names, [IntPtr]::Zero)
      $dm = @(for ($i = 0; $i -lt $n; $i++) {
        $name = [Runtime.InteropServices.Marshal]::PtrToStringUni([IntPtr]($names.ToInt64() + $i * 128), 64).Split([char]0)[0].Trim()
        [PSCustomObject]@{ id = [Runtime.InteropServices.Marshal]::ReadInt32($ids, $i * 4); name = $name }
      })
    } finally {
      [Runtime.InteropServices.Marshal]::FreeHGlobal($ids)
      [Runtime.InteropServices.Marshal]::FreeHGlobal($names)
    }
    $ps = New-Object System.Drawing.Printing.PrinterSettings
    $ps.PrinterName = $q.FullName
    $b = ZxDevmodeBytes $ps (New-Object System.Drawing.Printing.PageSettings($ps))
    if ($b.Length -ge 200 -and ([BitConverter]::ToUInt32($b, 72) -band 0x200000)) { $dmCurrent = [BitConverter]::ToInt32($b, 196) }
  }
} catch { }
[PSCustomObject]@{
  ok = $true
  dmMedia = $dm
  dmCurrent = $dmCurrent
  media = @($c.PageMediaTypeCapability | ForEach-Object { [string]$_ })
  quality = @($c.OutputQualityCapability | ForEach-Object { [string]$_ })
  res = @($c.PageResolutionCapability | Where-Object { $_.X -gt 0 } | ForEach-Object { [PSCustomObject]@{ x = [int]$_.X; y = [int]$_.Y } })
  current = [PSCustomObject]@{ media = [string]$t.PageMediaType; quality = [string]$t.OutputQuality; x = [int]$t.PageResolution.X; y = [int]$t.PageResolution.Y }
} | ConvertTo-Json -Compress -Depth 4
`;

const APPLY_SCRIPT = `${FIND_QUEUE}
$before = $q.UserPrintTicket
$ms = $before.GetXmlStream()
$saved = [Convert]::ToBase64String($ms.ToArray())
$t = $before.Clone()
$paperName = ''
if ($env:ZX_PAPER_W -or $env:ZX_DM_MEDIA) {
${NATIVE}
  # The printer's own DEVMODE with the driver's paper (photo sizes like 4x6 are
  # often only in its GDI list, found here by size) and/or its own paper type,
  # turned into a print ticket.
  $ps = New-Object System.Drawing.Printing.PrinterSettings
  $ps.PrinterName = $q.FullName
  $pg = New-Object System.Drawing.Printing.PageSettings($ps)
  $paperFound = $false
  if ($env:ZX_PAPER_W) {
    $w = [int]$env:ZX_PAPER_W; $h = [int]$env:ZX_PAPER_H
    $match = $ps.PaperSizes | Where-Object { ([Math]::Abs($_.Width - $w) -le 4 -and [Math]::Abs($_.Height - $h) -le 4) -or ([Math]::Abs($_.Width - $h) -le 4 -and [Math]::Abs($_.Height - $w) -le 4) } | Select-Object -First 1
    if ($match) { $pg.PaperSize = $match; $paperName = $match.PaperName; $paperFound = $true }
  }
  $pg.Landscape = $false
  $bytes = ZxDevmodeBytes $ps $pg
  if ($env:ZX_DM_MEDIA -and $bytes.Length -ge 200) {
    [BitConverter]::GetBytes([int]$env:ZX_DM_MEDIA).CopyTo($bytes, 196)
    [BitConverter]::GetBytes([uint32]([BitConverter]::ToUInt32($bytes, 72) -bor 0x200000)).CopyTo($bytes, 72)
  }
  $conv = New-Object System.Printing.Interop.PrintTicketConverter($q.FullName, $q.ClientPrintSchemaVersion)
  $t = $conv.ConvertDevModeToPrintTicket($bytes, [System.Printing.PrintTicketScope]::JobScope)
  if ($env:ZX_PAPER_W) {
    if (-not $paperFound) { $t.PageMediaSize = New-Object System.Printing.PageMediaSize([double]($w * 0.96), [double]($h * 0.96)) }
    $t.PageOrientation = [System.Printing.PageOrientation]::Portrait
  }
}
if ($env:ZX_MEDIA) { $t.PageMediaType = [System.Printing.PageMediaType]$env:ZX_MEDIA }
if ($env:ZX_QUALITY) { $t.OutputQuality = [System.Printing.OutputQuality]$env:ZX_QUALITY }
if ($env:ZX_DPI_X) { $t.PageResolution = New-Object System.Printing.PageResolution([int]$env:ZX_DPI_X, [int]$env:ZX_DPI_Y) }
$r = $q.MergeAndValidatePrintTicket($before, $t)
$q.UserPrintTicket = $r.ValidatedPrintTicket
$q.Commit()
$a = $q.UserPrintTicket
[PSCustomObject]@{
  ok = $true; saved = $saved; media = [string]$a.PageMediaType; quality = [string]$a.OutputQuality; x = [int]$a.PageResolution.X
  paperName = $paperName; paperW = [double]$a.PageMediaSize.Width; paperH = [double]$a.PageMediaSize.Height
} | ConvertTo-Json -Compress
`;

const RESTORE_SCRIPT = `${FIND_QUEUE}
$bytes = [Convert]::FromBase64String($env:ZX_TICKET)
$ms = New-Object System.IO.MemoryStream(,$bytes)
$q.UserPrintTicket = New-Object System.Printing.PrintTicket($ms)
$q.Commit()
'{"ok":true}'
`;

/** System.Printing enum names only: letters and digits. */
const ENUM_NAME = /^[A-Za-z][A-Za-z0-9]{0,40}$/;
/** A paper type from the driver's own list: its DEVMODE dmMediaType number. */
const DRIVER_MEDIA = /^dm:(\d{1,6})$/;

/** Values that mean "the driver didn't say" and shouldn't be offered. */
const NOT_A_CHOICE = new Set(["Unknown", "Unspecified", "AutoSelect", "None", ""]);

const MEDIA_LABEL: Record<string, string> = {
  Plain: "Plain paper",
  PhotographicGlossy: "Photo paper (glossy)",
  PhotographicHighGloss: "Photo paper (high gloss)",
  PhotographicSemiGloss: "Photo paper (semi-gloss)",
  PhotographicSatin: "Photo paper (satin)",
  PhotographicMatte: "Photo paper (matte)",
  Photographic: "Photo paper",
  PhotographicFilm: "Photo film",
  CardStock: "Card stock",
  Archival: "Archival paper",
  BondPaper: "Bond paper",
  Label: "Labels",
  Transparency: "Transparency",
  Envelope: "Envelope",
  Stationery: "Stationery",
  Continuous: "Continuous paper",
  Screen: "Screen",
  TShirtTransfer: "T-shirt transfer",
};

const QUALITY_LABEL: Record<string, string> = {
  Draft: "Draft",
  Fax: "Fax",
  Normal: "Normal",
  Text: "Text",
  High: "High",
  Photographic: "Photo",
  Automatic: "Automatic",
};

export function mediaLabel(name: string): string {
  return MEDIA_LABEL[name] ?? name.replace(/([a-z])([A-Z])/g, "$1 $2");
}

export function qualityLabel(name: string): string {
  return QUALITY_LABEL[name] ?? name.replace(/([a-z])([A-Z])/g, "$1 $2");
}

type CapsRow = {
  ok: boolean;
  error?: string;
  /** The driver's own paper types (DEVMODE dmMediaType), and the one set now (0 = none). */
  dmMedia?: { id: number; name: string }[] | { id: number; name: string } | null;
  dmCurrent?: number;
  media?: string[] | string | null;
  quality?: string[] | string | null;
  res?: PrintResolution[] | PrintResolution | null;
  current?: { media: string; quality: string; x: number; y: number };
};

function list<T>(v: T[] | T | null | undefined): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/** PowerShell's JSON → what the print options picker offers. Pure. */
export function toCapabilities(row: CapsRow): PrintCapabilities | null {
  if (!row.ok) return null;
  const uniq = (xs: string[]) => [...new Set(xs.filter((x) => ENUM_NAME.test(x) && !NOT_A_CHOICE.has(x)))];
  const seen = new Set<string>();
  const resolutions = list(row.res)
    .filter((r) => Number.isInteger(r.x) && r.x > 0 && Number.isInteger(r.y) && r.y > 0)
    .filter((r) => {
      const key = `${r.x}x${r.y}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.x - b.x || a.y - b.y);
  const standard = uniq(list(row.media)).map((value) => ({ value, label: mediaLabel(value) }));
  // Standard names when the driver gives them; otherwise its own list, named as in its Preferences.
  const driver = list(row.dmMedia)
    .filter((m) => Number.isInteger(m.id) && m.id > 0 && typeof m.name === "string" && m.name.trim())
    .filter((m, i, all) => all.findIndex((x) => x.id === m.id) === i)
    .map((m) => ({ value: `dm:${m.id}`, label: m.name.trim() }));
  const useDriver = standard.length === 0 && driver.length > 0;
  const driverCurrent = useDriver && row.dmCurrent && driver.some((m) => m.value === `dm:${row.dmCurrent}`) ? `dm:${row.dmCurrent}` : null;
  return {
    mediaTypes: useDriver ? driver : standard,
    qualities: uniq(list(row.quality)).map((value) => ({ value, label: qualityLabel(value) })),
    resolutions,
    current: row.current
      ? {
          mediaType: useDriver ? driverCurrent : NOT_A_CHOICE.has(row.current.media) ? null : row.current.media,
          quality: NOT_A_CHOICE.has(row.current.quality) ? null : row.current.quality,
          dpi: row.current.x > 0 ? row.current.x : null,
        }
      : null,
  };
}

/**
 * The resolution to ask the driver for: the exact DPI if offered (square
 * preferred), else the highest at or below it, else the lowest. 0 = the
 * printer's maximum. Null when the driver lists none.
 */
export function pickResolution(offered: PrintResolution[], dpi: number): PrintResolution | null {
  if (offered.length === 0) return null;
  const sorted = [...offered].sort((a, b) => a.x - b.x || a.y - b.y);
  if (!(dpi > 0)) return sorted.reduce((best, r) => (r.x * r.y > best.x * best.y ? r : best), sorted[0]);
  const exact = sorted.filter((r) => r.x === dpi);
  if (exact.length) return exact.find((r) => r.y === dpi) ?? exact[0];
  const below = sorted.filter((r) => r.x <= dpi);
  return below.length ? below[below.length - 1] : sorted[0];
}

async function run(script: string, env: Record<string, string>): Promise<unknown> {
  const { stdout } = await execFileAsync(POWERSHELL, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    env: { ...process.env, ...env },
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const text = stdout.trim();
  if (!text) throw new Error("No answer from Windows");
  return JSON.parse(text.split(/\r?\n/).pop() ?? text);
}

const capsCache = new Map<string, { at: number; caps: PrintCapabilities | null }>();
const CAPS_TTL_MS = 5 * 60_000;

/** What the driver offers; null when Windows can't say. Cached for a few minutes. */
export async function getPrintCapabilities(systemName: string, opts: { fresh?: boolean } = {}): Promise<PrintCapabilities | null> {
  const hit = capsCache.get(systemName);
  if (hit && !opts.fresh && Date.now() - hit.at < CAPS_TTL_MS) return hit.caps;
  let caps: PrintCapabilities | null = null;
  try {
    caps = toCapabilities((await run(CAPS_SCRIPT, { ZX_PRINTER: systemName })) as CapsRow);
  } catch (err) {
    log.warn(`[print-ticket] capabilities for ${systemName}`, err instanceof Error ? err.message : err);
  }
  capsCache.set(systemName, { at: Date.now(), caps });
  return caps;
}

export type AppliedTicket = {
  /** What was asked for that the driver took, for the job's status line. */
  summary: string;
  /** Puts the printer's settings back as they were. Never throws. */
  restore: () => Promise<void>;
};

/** True when there's nothing to change, so no PowerShell call is needed. */
export function isEmptyTicket(t: PrintTicketOptions | null | undefined): boolean {
  return !t || (!t.mediaType && !t.quality && t.dpi == null && !t.paper);
}

/** Whether the paper Windows ended up with is the one asked for (sizes in 1/96 in, as System.Printing gives them). Pure. */
export function paperMatches(asked: { widthMm: number; heightMm: number }, got: { w?: number; h?: number }): boolean {
  if (!(got.w && got.h)) return false;
  const mm = (px: number) => (px / 96) * 25.4;
  const [aw, ah] = [Math.min(asked.widthMm, asked.heightMm), Math.max(asked.widthMm, asked.heightMm)];
  const [gw, gh] = [Math.min(mm(got.w), mm(got.h)), Math.max(mm(got.w), mm(got.h))];
  return Math.abs(aw - gw) <= 2 && Math.abs(ah - gh) <= 2;
}

/** The printer couldn't be switched to the sheet's paper: printing anyway would stop with a paper-size error. */
export class PaperNotSetError extends Error {}

/**
 * Sets the printer's ticket for one print. Returns null (and logs) when
 * nothing was asked or Windows refused, so the caller prints with the
 * printer's own settings instead of failing the print — except the paper: a
 * sheet sent on the wrong paper stops the printer with a paper-size error, so
 * that throws PaperNotSetError instead.
 */
export async function applyPrintTicket(systemName: string, ticket: PrintTicketOptions | null | undefined): Promise<AppliedTicket | null> {
  if (isEmptyTicket(ticket)) return null;
  const t = ticket as PrintTicketOptions;
  const env: Record<string, string> = { ZX_PRINTER: systemName };
  if (t.mediaType) {
    const driver = DRIVER_MEDIA.exec(t.mediaType);
    if (driver) env.ZX_DM_MEDIA = driver[1];
    else if (ENUM_NAME.test(t.mediaType)) env.ZX_MEDIA = t.mediaType;
    else throw new Error(`Unknown paper type "${t.mediaType}"`);
  }
  if (t.quality) {
    if (!ENUM_NAME.test(t.quality)) throw new Error(`Unknown print quality "${t.quality}"`);
    env.ZX_QUALITY = t.quality;
  }
  if (t.dpi != null) {
    const caps = await getPrintCapabilities(systemName);
    const res = pickResolution(caps?.resolutions ?? [], t.dpi);
    if (res) {
      env.ZX_DPI_X = String(res.x);
      env.ZX_DPI_Y = String(res.y);
    } else if (t.dpi > 0) {
      env.ZX_DPI_X = String(t.dpi);
      env.ZX_DPI_Y = String(t.dpi);
    }
  }
  if (t.paper) {
    // Hundredths of an inch, portrait, as .NET's PaperSize gives them.
    env.ZX_PAPER_W = String(Math.round((Math.min(t.paper.widthMm, t.paper.heightMm) / 25.4) * 100));
    env.ZX_PAPER_H = String(Math.round((Math.max(t.paper.widthMm, t.paper.heightMm) / 25.4) * 100));
  }
  const paperLabel = t.paper ? `${t.paper.widthMm} × ${t.paper.heightMm} mm` : "";
  type Out = { ok: boolean; error?: string; saved?: string; media?: string; quality?: string; x?: number; paperName?: string; paperW?: number; paperH?: number };
  let out: Out;
  try {
    out = (await run(APPLY_SCRIPT, env)) as Out;
    if (!out.ok || !out.saved) throw new Error(out.error ?? "Windows didn't take the settings");
  } catch (err) {
    log.warn(`[print-ticket] applying to ${systemName}`, err instanceof Error ? err.message : err);
    if (t.paper) throw new PaperNotSetError(`Couldn't switch ${systemName} to ${paperLabel} paper. Choose that size in the printer's preferences and try again`);
    return null;
  }
  const saved = out.saved;
  const restore = async () => {
    try {
      await run(RESTORE_SCRIPT, { ZX_PRINTER: systemName, ZX_TICKET: saved });
    } catch (err) {
      log.warn(`[print-ticket] restoring ${systemName}`, err instanceof Error ? err.message : err);
    }
  };
  if (t.paper && !paperMatches(t.paper, { w: out.paperW, h: out.paperH })) {
    await restore();
    throw new PaperNotSetError(`${systemName} has no ${paperLabel} paper size. Add it as a custom size in the printer's preferences, or print on A4`);
  }
  const driverMedia = env.ZX_DM_MEDIA ? capsCache.get(systemName)?.caps?.mediaTypes.find((m) => m.value === t.mediaType)?.label : null;
  const parts = [
    t.paper ? out.paperName || paperLabel : null,
    driverMedia ?? (out.media && !NOT_A_CHOICE.has(out.media) ? mediaLabel(out.media) : null),
    out.quality && !NOT_A_CHOICE.has(out.quality) ? `${qualityLabel(out.quality)} quality` : null,
    out.x ? `${out.x} dpi` : null,
  ].filter(Boolean);
  return { summary: parts.join(", "), restore };
}

/** Opens the driver's own Printing Preferences dialog, like Ctrl+P → Preferences. */
export async function openPrinterPreferences(systemName: string): Promise<void> {
  // printui reads the name from its own argument; execFile passes it as one argv entry.
  await execFileAsync("C:\\Windows\\System32\\rundll32.exe", ["printui.dll,PrintUIEntry", "/e", "/n", systemName], { windowsHide: false, timeout: 0 }).catch(
    (err: unknown) => {
      throw new Error(`Couldn't open the printer's preferences: ${err instanceof Error ? err.message : String(err)}`);
    },
  );
  capsCache.delete(systemName);
}
