import { Printer, RefreshCw, ScanLine } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import type { PaperSize, PrinterStatus, ServerPrinter } from "../../../shared/types";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState } from "@/components/ui/primitives";
import { Switch } from "@/components/ui/switch";
import { run, useAppState } from "@/lib/app-state";
import { cn } from "@/lib/utils";

const STATUS: Record<PrinterStatus, { label: string; tone: "success" | "info" | "danger" | "neutral" }> = {
  ONLINE: { label: "Ready", tone: "success" },
  BUSY: { label: "Printing", tone: "info" },
  ERROR: { label: "Needs attention", tone: "danger" },
  OFFLINE: { label: "Offline", tone: "neutral" },
};

function Chip({ on, label, onClick, disabled }: { on: boolean; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "rounded-full px-3 py-1 font-mono text-[11px] font-bold uppercase tracking-[0.08em] transition-colors disabled:opacity-50",
        on ? "bg-deep text-deep-foreground" : "bg-muted text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

function PrinterCard({ printer }: { printer: ServerPrinter }) {
  const [busy, setBusy] = useState<string | null>(null);
  const status = STATUS[printer.status];

  async function patch(key: string, body: Record<string, unknown>) {
    setBusy(key);
    try {
      await run(window.zerox.updatePrinter(printer.id, body));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update the printer");
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    setBusy("test");
    try {
      await run(window.zerox.testPrinter(printer.id));
      toast.success(`Test page sent to ${printer.displayName}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Test page failed");
    } finally {
      setBusy(null);
    }
  }

  const togglePaper = (p: PaperSize) => {
    const next = printer.paperSizes.includes(p) ? printer.paperSizes.filter((x) => x !== p) : [...printer.paperSizes, p];
    if (next.length === 0) return toast.error("A printer needs at least one paper size");
    void patch("paper", { paperSizes: next });
  };

  return (
    <Card className={cn("p-5", !printer.isEnabled && "bg-card/60")}>
      <div className="flex items-start gap-4">
        <span className={cn("grid size-11 shrink-0 place-items-center rounded-xl", printer.isEnabled ? "bg-deep text-lime" : "bg-muted text-muted-foreground")}>
          <Printer className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <p className="truncate font-display text-lg font-bold tracking-[-0.02em]">{printer.displayName}</p>
            <Badge tone={status.tone} pulse={printer.status === "BUSY"}>
              {status.label}
            </Badge>
          </div>
          {printer.statusMessage && printer.status !== "ONLINE" && <p className="mt-0.5 text-sm text-muted-foreground">{printer.statusMessage}</p>}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Chip on={printer.supportsColor} label="Color" disabled={!!busy} onClick={() => void patch("color", { supportsColor: !printer.supportsColor })} />
            <Chip on={printer.supportsDuplex} label="Double-sided" disabled={!!busy} onClick={() => void patch("duplex", { supportsDuplex: !printer.supportsDuplex })} />
            <Chip on={printer.paperSizes.includes("A4")} label="A4" disabled={!!busy} onClick={() => togglePaper("A4")} />
            <Chip on={printer.paperSizes.includes("A3")} label="A3" disabled={!!busy} onClick={() => togglePaper("A3")} />
            <span className="ml-1 text-caption font-normal text-muted-foreground">
              {printer.capabilitiesOverridden ? "Set by you" : "From the Windows driver. Tap to correct."}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-3">
          <Switch
            checked={printer.isEnabled}
            disabled={busy === "enable"}
            onChange={(next) => void patch("enable", { isEnabled: next })}
            ariaLabel={`Use ${printer.displayName} for Zerox Buddy`}
          />
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              Priority
              <select
                value={printer.priority}
                disabled={!!busy}
                onChange={(e) => void patch("priority", { priority: Number(e.target.value) })}
                className="h-8 rounded-lg border border-input bg-card px-2 text-sm text-foreground"
              >
                {[0, 1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {["1st", "2nd", "3rd", "4th", "5th", "6th"][n]}
                  </option>
                ))}
              </select>
            </label>
            <Button size="sm" variant="secondary" onClick={test} loading={busy === "test"}>
              Test page
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

export function PrintersScreen() {
  const state = useAppState()!;
  const [scanning, setScanning] = useState(false);
  const limit = state.entitlements?.printerLimit ?? null;
  const enabled = state.printers.filter((p) => p.isEnabled).length;

  async function scan() {
    setScanning(true);
    try {
      await run(window.zerox.refreshPrinters());
    } finally {
      setScanning(false);
    }
  }

  return (
    <>
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-title">Printers</h1>
          <p className="mt-1 text-[15px] text-muted-foreground">
            Turn on the printers Zerox Buddy may use. Jobs only go to a printer that can print them.
          </p>
        </div>
        <div className="flex items-center gap-4">
          {limit !== null && (
            <p className="font-mono text-[12px] uppercase tracking-[0.12em] text-muted-foreground">
              {enabled} of {limit} in use
            </p>
          )}
          <Button variant="secondary" onClick={scan} loading={scanning}>
            {!scanning && <RefreshCw aria-hidden />} Scan again
          </Button>
        </div>
      </div>
      {state.printers.length === 0 ? (
        <Card>
          <EmptyState
            icon={ScanLine}
            title="No printers found"
            description="Install your printer in Windows (Settings, Printers & scanners), then press Scan again. Receipt and PDF printers are not listed."
          />
        </Card>
      ) : (
        <div className="grid gap-3">
          {state.printers.map((p) => (
            <PrinterCard key={p.id} printer={p} />
          ))}
        </div>
      )}
      {limit !== null && enabled >= limit && state.printers.length > enabled && (
        <p className="mt-4 text-sm text-muted-foreground">
          Your {state.entitlements?.planName} plan allows {limit} {limit === 1 ? "printer" : "printers"}.{" "}
          <button className="font-semibold text-foreground underline decoration-lime decoration-2 underline-offset-4" onClick={() => void window.zerox.openWebDashboard("/subscription")}>
            Upgrade to add more
          </button>
        </p>
      )}
    </>
  );
}
