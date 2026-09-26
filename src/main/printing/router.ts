import type { PaperSize, PrintType, ServerPrinter } from "../../shared/types";

/**
 * Picks the printer a job goes to (spec §24). Pure, so every rule is unit
 * tested without a printer in sight:
 *
 *   1. compatible   color / paper size / double-sided the job needs
 *   2. available    turned on in Zerox Buddy and not offline or in error
 *   3. least busy   fewest jobs this computer is already sending to it
 *   4. priority     the owner's order (lower first), then name for stability
 *
 * Returns the reason when nothing fits, in words the counter can act on.
 */

export type RouteJob = { printType: PrintType | null; paperSize: PaperSize | null; duplex: boolean };

export type RouteResult = { ok: true; printer: ServerPrinter } | { ok: false; reason: string };

export function canPrint(printer: ServerPrinter, job: RouteJob): boolean {
  if (job.printType === "COLOR" && !printer.supportsColor) return false;
  if (job.paperSize && !printer.paperSizes.includes(job.paperSize)) return false;
  if (job.duplex && !printer.supportsDuplex) return false;
  return true;
}

function describe(job: RouteJob): string {
  const parts = [job.printType === "COLOR" ? "color" : "black & white", job.paperSize ?? "A4"];
  if (job.duplex) parts.push("double-sided");
  return parts.join(", ");
}

export function routeJob(
  job: RouteJob,
  printers: ServerPrinter[],
  load: Record<string, number> = {},
): RouteResult {
  const enabled = printers.filter((p) => p.isEnabled);
  if (enabled.length === 0) return { ok: false, reason: "No printer is turned on. Turn one on in Printers." };

  const compatible = enabled.filter((p) => canPrint(p, job));
  if (compatible.length === 0) return { ok: false, reason: `No printer here can print ${describe(job)}.` };

  const available = compatible.filter((p) => p.status !== "OFFLINE" && p.status !== "ERROR");
  if (available.length === 0) {
    const names = compatible.map((p) => p.displayName).join(", ");
    return { ok: false, reason: `${names} ${compatible.length === 1 ? "is" : "are"} offline or needs attention.` };
  }

  const sorted = [...available].sort(
    (a, b) =>
      (load[a.id] ?? 0) - (load[b.id] ?? 0) ||
      a.priority - b.priority ||
      a.displayName.localeCompare(b.displayName),
  );
  return { ok: true, printer: sorted[0]! };
}
