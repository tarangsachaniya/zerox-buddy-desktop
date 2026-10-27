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

const CAPS_SCRIPT = `${FIND_QUEUE}
$c = $q.GetPrintCapabilities()
$t = $q.UserPrintTicket
[PSCustomObject]@{
  ok = $true
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
if ($env:ZX_MEDIA) { $t.PageMediaType = [System.Printing.PageMediaType]$env:ZX_MEDIA }
if ($env:ZX_QUALITY) { $t.OutputQuality = [System.Printing.OutputQuality]$env:ZX_QUALITY }
if ($env:ZX_DPI_X) { $t.PageResolution = New-Object System.Printing.PageResolution([int]$env:ZX_DPI_X, [int]$env:ZX_DPI_Y) }
$r = $q.MergeAndValidatePrintTicket($before, $t)
$q.UserPrintTicket = $r.ValidatedPrintTicket
$q.Commit()
$a = $q.UserPrintTicket
[PSCustomObject]@{ ok = $true; saved = $saved; media = [string]$a.PageMediaType; quality = [string]$a.OutputQuality; x = [int]$a.PageResolution.X } | ConvertTo-Json -Compress
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
  return {
    mediaTypes: uniq(list(row.media)).map((value) => ({ value, label: mediaLabel(value) })),
    qualities: uniq(list(row.quality)).map((value) => ({ value, label: qualityLabel(value) })),
    resolutions,
    current: row.current
      ? {
          mediaType: NOT_A_CHOICE.has(row.current.media) ? null : row.current.media,
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
  return !t || (!t.mediaType && !t.quality && t.dpi == null);
}

/**
 * Sets the printer's ticket for one print. Returns null (and logs) when
 * nothing was asked or Windows refused, so the caller prints with the
 * printer's own settings instead of failing the print.
 */
export async function applyPrintTicket(systemName: string, ticket: PrintTicketOptions | null | undefined): Promise<AppliedTicket | null> {
  if (isEmptyTicket(ticket)) return null;
  const t = ticket as PrintTicketOptions;
  const env: Record<string, string> = { ZX_PRINTER: systemName };
  if (t.mediaType) {
    if (!ENUM_NAME.test(t.mediaType)) throw new Error(`Unknown paper type "${t.mediaType}"`);
    env.ZX_MEDIA = t.mediaType;
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
  try {
    const out = (await run(APPLY_SCRIPT, env)) as { ok: boolean; error?: string; saved?: string; media?: string; quality?: string; x?: number };
    if (!out.ok || !out.saved) throw new Error(out.error ?? "Windows didn't take the settings");
    const saved = out.saved;
    const parts = [
      out.media && !NOT_A_CHOICE.has(out.media) ? mediaLabel(out.media) : null,
      out.quality && !NOT_A_CHOICE.has(out.quality) ? `${qualityLabel(out.quality)} quality` : null,
      out.x ? `${out.x} dpi` : null,
    ].filter(Boolean);
    return {
      summary: parts.join(", "),
      restore: async () => {
        try {
          await run(RESTORE_SCRIPT, { ZX_PRINTER: systemName, ZX_TICKET: saved });
        } catch (err) {
          log.warn(`[print-ticket] restoring ${systemName}`, err instanceof Error ? err.message : err);
        }
      },
    };
  } catch (err) {
    log.warn(`[print-ticket] applying to ${systemName}`, err instanceof Error ? err.message : err);
    return null;
  }
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
