import { AlertTriangle, Eye, FileText, Image as ImageIcon, Inbox, Printer, RefreshCw, RotateCcw, Trash2, Undo2, Zap } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import type { AppState, QueueJob, ServerPrinter } from "../../../shared/types";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Badge, Card, EmptyState } from "@/components/ui/primitives";
import { run, useAppState } from "@/lib/app-state";
import { cn } from "@/lib/utils";

function rupees(n: number): string {
  return `₹${n.toLocaleString("en-IN", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

function time(iso: string | null): string {
  return iso ? new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" }) : "";
}

function compatible(job: QueueJob, printers: ServerPrinter[]): ServerPrinter[] {
  return printers.filter(
    (p) =>
      p.isEnabled &&
      (job.printType !== "COLOR" || p.supportsColor) &&
      (!job.paperSize || p.paperSizes.includes(job.paperSize)) &&
      (!job.duplex || p.supportsDuplex),
  );
}

function Options({ job }: { job: QueueJob }) {
  const chips = [
    job.printType === "COLOR" ? "Color" : "B&W",
    job.paperSize ?? "A4",
    `${job.totalPages} ${job.totalPages === 1 ? "page" : "pages"}`,
    `${job.copies} ${job.copies === 1 ? "copy" : "copies"}`,
    job.duplex ? "Double-sided" : null,
  ].filter(Boolean) as string[];
  return (
    <div className="flex flex-wrap gap-1.5">
      {chips.map((c) => (
        <span
          key={c}
          className={cn(
            "rounded-full px-2.5 py-0.5 text-caption",
            c === "Color" ? "bg-lime text-deep" : "bg-muted text-muted-foreground",
          )}
        >
          {c}
        </span>
      ))}
    </div>
  );
}

function Files({ job }: { job: QueueJob }) {
  return (
    <ul className="mt-2 space-y-1">
      {job.files.map((f) => (
        <li key={f.id} className="flex items-center gap-2 text-sm">
          {f.mimeType === "application/pdf" ? (
            <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          ) : (
            <ImageIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <span className="truncate">{f.originalName}</span>
          {f.pageRanges && <span className="shrink-0 font-mono text-[11px] text-muted-foreground">pages {f.pageRanges}</span>}
        </li>
      ))}
    </ul>
  );
}

function Specimen({ job }: { job: QueueJob }) {
  return (
    <div className="w-24 shrink-0">
      <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Specimen</p>
      <p className="font-mono text-[2rem] font-bold leading-none tabular-nums">#{job.specimenNo}</p>
      <p className="mt-1 font-mono text-[11px] text-muted-foreground">{time(job.queuedAt)}</p>
    </div>
  );
}

function DeleteJob({ job }: { job: QueueJob }) {
  const [open, setOpen] = useState(false);

  async function remove() {
    try {
      await run(window.zerox.deleteJob(job.id));
      toast.success(`#${job.specimenNo} deleted`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't delete it");
    }
  }

  return (
    <>
      <Button size="icon-sm" variant="ghost" aria-label={`Delete #${job.specimenNo}`} title="Delete" onClick={() => setOpen(true)}>
        <Trash2 aria-hidden />
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Delete print request #${job.specimenNo}?`}
        description={
          job.status === "COMPLETED"
            ? "The customer's file is removed and this job drops out of your sales figures. This can't be undone."
            : "The customer's file is removed and the request disappears from the queue. This can't be undone."
        }
        confirmLabel="Delete"
        destructive
        onConfirm={remove}
      />
    </>
  );
}

function WaitingJob({ job, state }: { job: QueueJob; state: AppState }) {
  const options = compatible(job, state.printers);
  const [printerId, setPrinterId] = useState(options[0]?.id ?? "");
  const [busy, setBusy] = useState<"print" | "preview" | null>(null);
  const local = state.local[job.id];
  const blocked = state.blocked[job.id];

  async function act(kind: "print" | "preview") {
    setBusy(kind);
    try {
      await run(kind === "print" ? window.zerox.printJob(job.id, printerId) : window.zerox.previewJob(job.id, printerId));
      if (kind === "print") toast.success(`#${job.specimenNo} sent to print`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't print");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="flex gap-5 p-5">
      <Specimen job={job} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <Options job={job} />
          <p className="shrink-0 text-right">
            <span className="font-display text-lg font-bold tabular-nums">{rupees(job.amount)}</span>
            <span className="block text-caption font-normal text-muted-foreground">{job.paymentStatus === "PAID" ? "Paid" : "To collect"}</span>
          </p>
        </div>
        <Files job={job} />
        {local ? (
          <p className="mt-3 text-sm font-medium">
            {local.phase === "claiming" ? "Starting…" : local.phase === "downloading" ? "Downloading…" : "Printing…"} {local.printerName && `on ${local.printerName}`}
          </p>
        ) : (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {blocked && options.length === 0 ? (
              <p className="flex items-center gap-2 text-sm text-warning-foreground">
                <AlertTriangle className="size-4" aria-hidden /> {blocked}
              </p>
            ) : (
              <>
                <select
                  aria-label={`Printer for #${job.specimenNo}`}
                  value={printerId}
                  onChange={(e) => setPrinterId(e.target.value)}
                  className="h-10 rounded-full border border-input bg-card px-4 text-sm"
                >
                  {options.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayName}
                      {p.status !== "ONLINE" && p.status !== "BUSY" ? " (offline)" : ""}
                    </option>
                  ))}
                </select>
                <Button onClick={() => act("print")} loading={busy === "print"} disabled={!printerId || !!busy}>
                  {busy !== "print" && <Printer aria-hidden />} Print
                </Button>
                <Button variant="secondary" onClick={() => act("preview")} loading={busy === "preview"} disabled={!printerId || !!busy}>
                  {busy !== "preview" && <Eye aria-hidden />} Preview
                </Button>
                {blocked && <span className="text-caption font-normal text-muted-foreground">{blocked}</span>}
              </>
            )}
            <span className="ml-auto">
              <DeleteJob job={job} />
            </span>
          </div>
        )}
      </div>
    </Card>
  );
}

function ActiveJob({ job, state }: { job: QueueJob; state: AppState }) {
  const local = state.local[job.id];
  const mine = job.assignedDeviceId && state.printers.some((p) => p.id === job.assignedPrinterId);
  const printer = state.printers.find((p) => p.id === job.assignedPrinterId);
  const previewing = local?.message === "Previewing";
  const [busy, setBusy] = useState(false);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="flex gap-5 border-0 bg-deep p-5 text-deep-foreground">
      <div className="w-24 shrink-0">
        <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-deep-foreground/60">Specimen</p>
        <p className="font-mono text-[2rem] font-bold leading-none text-lime tabular-nums">#{job.specimenNo}</p>
      </div>
      <div className="min-w-0 flex-1">
        <p className="font-display text-lg font-bold">
          {previewing
            ? "Waiting for you to confirm"
            : job.status === "PRINTING"
              ? "Printing"
              : job.status === "DOWNLOADING"
                ? "Downloading"
                : "Starting"}
          {printer && <span className="font-sans text-sm font-normal text-deep-foreground/70"> on {printer.displayName}</span>}
          {!mine && <span className="font-sans text-sm font-normal text-deep-foreground/70"> on another computer</span>}
        </p>
        <p className="mt-1 text-sm text-deep-foreground/70">
          {job.files.map((f) => f.originalName).join(", ")} · {job.totalPages * job.copies} pages
        </p>
        {previewing && (
          <div className="mt-4 flex gap-2">
            <Button variant="lime" onClick={() => act(() => run(window.zerox.printJob(job.id, job.assignedPrinterId!)))} loading={busy}>
              <Printer aria-hidden /> Print it
            </Button>
            <Button
              variant="ghost"
              className="text-deep-foreground hover:bg-deep-foreground/10"
              onClick={() => act(() => run(window.zerox.previewJob(job.id, job.assignedPrinterId!)))}
            >
              <Eye aria-hidden /> Open again
            </Button>
            <Button
              variant="ghost"
              className="text-deep-foreground hover:bg-deep-foreground/10"
              onClick={() => act(() => run(window.zerox.putBackJob(job.id)))}
            >
              <Undo2 aria-hidden /> Put back
            </Button>
          </div>
        )}
      </div>
      {!previewing && <span className="mt-1 size-2.5 shrink-0 animate-pulse-dot rounded-full bg-lime" aria-hidden />}
    </Card>
  );
}

function RecentJob({ job }: { job: QueueJob }) {
  const [busy, setBusy] = useState(false);
  const [confirmRetry, setConfirmRetry] = useState(false);
  const failed = job.status === "FAILED";

  async function retry() {
    setBusy(true);
    try {
      await run(window.zerox.retryJob(job.id));
      toast.success(`#${job.specimenNo} is back in the queue`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't send it again");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex items-center gap-4 py-3">
      <span className="w-16 font-mono text-sm font-bold tabular-nums">#{job.specimenNo}</span>
      <span className="min-w-0 flex-1 truncate text-sm">
        {job.files.map((f) => f.originalName).join(", ") || "Files removed"}
        {failed && job.lastAttempt?.error && <span className="block truncate text-caption font-normal text-destructive">{job.lastAttempt.error}</span>}
      </span>
      <Badge tone={failed ? "danger" : job.status === "COMPLETED" ? "success" : "neutral"}>
        {failed ? "Failed" : job.status === "COMPLETED" ? "Printed" : "Cancelled"}
      </Badge>
      <span className="w-20 text-right font-mono text-[11px] text-muted-foreground">{time(job.completedAt ?? job.queuedAt)}</span>
      {failed && (
        <>
          <Button size="sm" variant="secondary" loading={busy} onClick={() => setConfirmRetry(true)}>
            {!busy && <RotateCcw aria-hidden />} Print again
          </Button>
          <ConfirmDialog
            open={confirmRetry}
            onOpenChange={setConfirmRetry}
            title={`Print #${job.specimenNo} again?`}
            description="Check the printer tray first: some pages may have printed."
            confirmLabel="Print again"
            destructive
            onConfirm={retry}
          />
        </>
      )}
      <DeleteJob job={job} />
    </li>
  );
}

export function QueueScreen() {
  const state = useAppState()!;
  const { queue, shop, entitlements } = state;
  const [refreshing, setRefreshing] = useState(false);
  const enabled = state.printers.filter((p) => p.isEnabled);
  const auto = !!shop && shop.autoPrint && shop.autoRouting && !shop.requirePreview;

  const active = useMemo(
    () => [...queue.active].sort((a, b) => (a.queuedAt ?? "").localeCompare(b.queuedAt ?? "")),
    [queue.active],
  );

  return (
    <>
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-title">Print queue</h1>
          <p className="mt-1 flex items-center gap-2 text-[15px] text-muted-foreground">
            {auto ? (
              <>
                <Zap className="size-4 text-foreground" aria-hidden /> Printing automatically as requests arrive
              </>
            ) : (
              "Press Print for each request"
            )}
            <Link to="/settings" className="text-sm underline decoration-border-strong underline-offset-4 hover:decoration-foreground">
              Change
            </Link>
          </p>
        </div>
        <Button
          variant="secondary"
          loading={refreshing}
          onClick={async () => {
            setRefreshing(true);
            await window.zerox.refreshQueue();
            setRefreshing(false);
          }}
        >
          {!refreshing && <RefreshCw aria-hidden />} Refresh
        </Button>
      </div>

      {entitlements?.trialExpired && (
        <div role="alert" className="mb-5 flex items-start gap-3 rounded-2xl bg-warning/10 p-4 text-sm text-warning-foreground">
          <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden />
          <p>
            <span className="font-semibold">Your free trial has ended.</span> Customers can&apos;t send new online orders until a plan is active.
            Requests already here still print.{" "}
            <Link to="/subscription" className="font-semibold underline underline-offset-4">
              See plans
            </Link>
          </p>
        </div>
      )}
      {state.error && <p className="mb-5 rounded-2xl bg-destructive/10 p-4 text-sm text-destructive">{state.error}</p>}
      {enabled.length === 0 && (
        <div className="mb-5 flex items-center justify-between gap-3 rounded-2xl bg-lime/40 p-4 text-sm text-deep">
          <p>
            <span className="font-semibold">No printer is turned on.</span> Choose which printers Zerox Buddy may use.
          </p>
          <Link to="/printers" className="rounded-full bg-deep px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.12em] text-deep-foreground">
            Set up printers
          </Link>
        </div>
      )}

      {active.length > 0 && (
        <section className="mb-8">
          <h2 className="text-overline mb-3 text-muted-foreground">Printing now</h2>
          <div className="grid gap-3">
            {active.map((j) => (
              <ActiveJob key={j.id} job={j} state={state} />
            ))}
          </div>
        </section>
      )}

      <section className="mb-8">
        <h2 className="text-overline mb-3 text-muted-foreground">Waiting · {queue.waiting.length}</h2>
        {queue.waiting.length === 0 ? (
          <Card>
            <EmptyState
              icon={Inbox}
              title="Nothing waiting"
              description="New print requests from your QR code appear here the moment customers submit them."
            />
          </Card>
        ) : (
          <div className="grid gap-3">
            {queue.waiting.map((j) => (
              <WaitingJob key={j.id} job={j} state={state} />
            ))}
          </div>
        )}
      </section>

      {queue.recent.length > 0 && (
        <section>
          <h2 className="text-overline mb-3 text-muted-foreground">Today</h2>
          <Card className="px-5">
            <ul className="divide-y">
              {queue.recent.map((j) => (
                <RecentJob key={j.id} job={j} />
              ))}
            </ul>
          </Card>
        </section>
      )}
    </>
  );
}
