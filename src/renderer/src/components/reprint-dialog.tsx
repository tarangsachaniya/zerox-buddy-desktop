import { AlertTriangle, Printer } from "lucide-react";
import { useEffect, useState } from "react";

import type { LocalPrintJob, QueueJob, ServerPrinter } from "../../../shared/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";

/** What the dialog shows about the print being repeated. */
export type ReprintSummary = {
  key: string;
  title: string;
  uncertain: boolean;
  mayHavePrinted: boolean;
  rows: [string, string][];
};

export function queueJobSummary(job: QueueJob): ReprintSummary {
  return {
    key: job.id,
    title: `Print #${job.specimenNo} again?`,
    uncertain: job.status === "UNKNOWN",
    mayHavePrinted: !!job.lastAttempt?.pagesSent,
    rows: [
      ["Files", job.files.map((f) => f.originalName).join(", ") || "Files removed"],
      ["Print", `${job.printType === "COLOR" ? "Color" : "Black & white"}, ${job.duplex ? "double-sided" : "single-sided"}`],
      ["Paper", `${job.paperSize ?? "A4"}${job.orientation === "LANDSCAPE" ? ", landscape" : ""}`],
      ["Pages", `${job.totalPages} × ${job.copies} ${job.copies === 1 ? "copy" : "copies"}`],
    ],
  };
}

export function localJobSummary(job: LocalPrintJob): ReprintSummary {
  const s = job.settings;
  return {
    key: job.id,
    title: "Print it again?",
    uncertain: job.status === "UNKNOWN",
    mayHavePrinted: job.attempts[job.attempts.length - 1]?.handedOff ?? false,
    rows: [
      ["Files", job.files.map((f) => f.name + (f.pageRanges ? ` (pages ${f.pageRanges})` : "")).join(", ")],
      ["Print", `${s.printType === "COLOR" ? "Color" : "Black & white"}, ${s.duplex ? "double-sided" : "single-sided"}`],
      ["Paper", `${s.paperSize}${s.orientation === "LANDSCAPE" ? ", landscape" : ""}`],
      ["Pages", `${job.pages} × ${s.copies} ${s.copies === 1 ? "copy" : "copies"}`],
    ],
  };
}

/**
 * "Print again" for a FAILED or UNKNOWN request. Shows what will be printed
 * (the customer's choices, which set the price, so they're not editable
 * here), lets the counter pick the printer, and for UNKNOWN says plainly that
 * the last attempt may already be on the tray. The confirm button waits a
 * moment so it can't be clicked through without reading.
 */
export function ReprintDialog({
  summary,
  printers,
  open,
  onOpenChange,
  onConfirm,
}: {
  summary: ReprintSummary;
  /** Already filtered to printers that can take this job, best first. */
  printers: ServerPrinter[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (printerId: string) => Promise<void>;
}) {
  const { uncertain, rows } = summary;
  const [printerId, setPrinterId] = useState(printers[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(!uncertain);

  useEffect(() => {
    if (!open) return;
    setPrinterId((id) => (printers.some((p) => p.id === id) ? id : (printers[0]?.id ?? "")));
    if (!uncertain) return setArmed(true);
    setArmed(false);
    const t = setTimeout(() => setArmed(true), 3000);
    return () => clearTimeout(t);
  }, [open, uncertain, printers]);

  async function confirm() {
    setBusy(true);
    try {
      await onConfirm(printerId);
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent title={summary.title}>
        {uncertain ? (
          <p role="alert" className="flex gap-2.5 rounded-2xl bg-warning/10 p-3.5 text-sm text-warning-foreground">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              <span className="font-semibold">The last attempt may already have printed.</span> Check the printer tray first. Printing again can make
              duplicate copies.
            </span>
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            {summary.mayHavePrinted ? "Some pages may have printed before it failed. Check the tray first." : "Nothing was printed last time."}
          </p>
        )}

        <dl className="mt-4 divide-y rounded-2xl bg-muted/50 text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="flex gap-4 px-4 py-2.5">
              <dt className="w-16 shrink-0 text-muted-foreground">{k}</dt>
              <dd className="min-w-0 break-words">{v}</dd>
            </div>
          ))}
        </dl>

        <label className="mt-4 block text-sm font-medium" htmlFor={`reprint-${summary.key}`}>
          Printer
        </label>
        {printers.length === 0 ? (
          <p className="mt-1.5 text-sm text-destructive">No turned-on printer can print this request.</p>
        ) : (
          <select
            id={`reprint-${summary.key}`}
            value={printerId}
            onChange={(e) => setPrinterId(e.target.value)}
            className="mt-1.5 h-10 w-full rounded-full border border-input bg-card px-4 text-sm"
          >
            {printers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
                {p.status !== "ONLINE" && p.status !== "BUSY" ? " (offline)" : ""}
              </option>
            ))}
          </select>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Don&apos;t print
          </Button>
          <Button onClick={() => void confirm()} loading={busy} disabled={!printerId || !armed || busy}>
            {!busy && <Printer aria-hidden />} {uncertain ? "Print again anyway" : "Print again"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
