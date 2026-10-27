import { execFileSync } from "node:child_process";

import { describe, expect, test, vi } from "vitest";

vi.mock("../log", () => ({ log: { warn: (...a: unknown[]) => console.warn(...a), info: () => {} } }));

import { applyPrintTicket } from "./print-ticket";

/**
 * Against a real printer, nothing printed: ZX_LIVE_PRINTER="HP Ink Tank Wireless 410 series" npx vitest run print-ticket.live
 * Switches it to 4×6 in through the ticket, checks Windows took it, then puts it back.
 */
const PRINTER = process.env.ZX_LIVE_PRINTER;

function currentPaperMm(name: string): string {
  const script = `Add-Type -AssemblyName System.Printing
$srv = New-Object System.Printing.LocalPrintServer
$q = $srv.GetPrintQueues(@([System.Printing.EnumeratedPrintQueueTypes]::Local, [System.Printing.EnumeratedPrintQueueTypes]::Connections)) | Where-Object { $_.FullName -eq $env:ZX_PRINTER } | Select-Object -First 1
$s = $q.UserPrintTicket.PageMediaSize
"{0}x{1}" -f [math]::Round($s.Width/96*25.4,1), [math]::Round($s.Height/96*25.4,1)`;
  return execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { env: { ...process.env, ZX_PRINTER: name } }).toString().trim();
}

describe.skipIf(!PRINTER)("print ticket on a real printer", () => {
  test("switches to 4 × 6 in for the print and puts the printer back", async () => {
    const name = PRINTER as string;
    const before = currentPaperMm(name);
    const applied = await applyPrintTicket(name, { paper: { widthMm: 101.6, heightMm: 152.4 }, quality: "High" });
    expect(applied).not.toBeNull();
    console.log("applied:", applied?.summary, "→", currentPaperMm(name));
    expect(currentPaperMm(name)).toBe("101.6x152.4");
    await applied!.restore();
    expect(currentPaperMm(name)).toBe(before);
  }, 120_000);
});
