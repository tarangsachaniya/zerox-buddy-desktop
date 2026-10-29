import { CheckCheck, Monitor, RotateCcw, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import type { AppState, LocalJobStatus, LocalPrintJob } from "../../../shared/types";
import { ReprintDialog, localJobSummary } from "@/components/reprint-dialog";
import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/primitives";
import { run } from "@/lib/app-state";
import { canPrintLocally } from "@/lib/local-print";

/**
 * Prints from this computer (Print from PC), with the same
 * statuses and recovery as the server's jobs. They live on this computer,
 * so they keep working with no internet.
 */

const STATUS: Record<LocalJobStatus, { label: string; tone: "neutral" | "warning" | "info" | "success" | "danger" }> = {
  QUEUED: { label: "Waiting", tone: "warning" },
  SUBMITTING: { label: "Sending to printer", tone: "info" },
  PRINTING: { label: "Printing", tone: "info" },
  COMPLETED: { label: "Printed", tone: "success" },
  FAILED: { label: "Failed", tone: "danger" },
  UNKNOWN: { label: "Check the tray", tone: "warning" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
};

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
}

function LocalJobRow({ job, state }: { job: LocalPrintJob; state: AppState }) {
  const [busy, setBusy] = useState(false);
  const [reprinting, setReprinting] = useState(false);
  const status = STATUS[job.status];
  const last = job.attempts[job.attempts.length - 1];
  const printers = state.printers.filter((p) => p.isEnabled && canPrintLocally(p, job.settings));
  const settled = job.status === "COMPLETED" || job.status === "FAILED" || job.status === "CANCELLED" || job.status === "UNKNOWN";

  async function act(fn: () => Promise<unknown>, done?: string) {
    setBusy(true);
    try {
      await fn();
      if (done) toast.success(done);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
      throw err;
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="py-3">
      <div className="flex items-center gap-3">
        <Monitor className="size-4 shrink-0 text-muted-foreground" aria-label="From this PC" />
        <span className="min-w-0 flex-1 truncate text-sm">
          {job.files.map((f) => f.name).join(", ")}
          <span className="block truncate text-caption font-normal text-muted-foreground">
            {job.pages * job.settings.copies} pages · {last?.printerName ?? "—"}
            {job.attempts.length > 1 && ` · attempt ${job.attempts.length}`}
          </span>
          {job.error && (job.status === "FAILED" || job.status === "UNKNOWN") && (
            <span className="block truncate text-caption font-normal text-destructive">{job.error}</span>
          )}
        </span>
        <Badge tone={status.tone} pulse={job.status === "PRINTING" || job.status === "SUBMITTING"}>
          {status.label}
        </Badge>
        <span className="w-16 text-right font-mono text-[11px] text-muted-foreground">{time(job.updatedAt)}</span>
        {settled && (
          <Button size="icon-sm" variant="ghost" aria-label="Remove from the list" title="Remove from the list" disabled={busy} onClick={() => void act(() => run(window.zerox.localPrint.dismiss(job.id))).catch(() => {})}>
            <X aria-hidden />
          </Button>
        )}
      </div>
      {(job.status === "UNKNOWN" || job.status === "FAILED") && (
        <div className="mt-2 flex flex-wrap gap-2 pl-7">
          {job.status === "UNKNOWN" && (
            <Button size="sm" onClick={() => void act(() => run(window.zerox.localPrint.confirmPrinted(job.id)), "Marked as printed").catch(() => {})} loading={busy} disabled={busy}>
              {!busy && <CheckCheck aria-hidden />} Yes, it printed
            </Button>
          )}
          {job.canRetry ? (
            <Button size="sm" variant="secondary" onClick={() => setReprinting(true)} disabled={busy}>
              <RotateCcw aria-hidden /> Print again…
            </Button>
          ) : (
            <span className="self-center text-caption text-muted-foreground">To print again, choose the file again with Print from PC.</span>
          )}
        </div>
      )}
      <ReprintDialog
        summary={localJobSummary(job)}
        printers={printers}
        open={reprinting}
        onOpenChange={setReprinting}
        onConfirm={(printerId) => act(() => run(window.zerox.localPrint.retry(job.id, printerId, job.status === "UNKNOWN")), "Sent to print again")}
      />
    </li>
  );
}

export function LocalJobs({ state }: { state: AppState }) {
  if (state.localJobs.length === 0) return null;
  return (
    <section className="mb-8">
      <h2 className="text-overline mb-3 text-muted-foreground">From this PC</h2>
      <Card className="px-5">
        <ul className="divide-y">
          {state.localJobs.slice(0, 30).map((j) => (
            <LocalJobRow key={j.id} job={j} state={state} />
          ))}
        </ul>
      </Card>
    </section>
  );
}
