import { FileText, HardDrive, Image as ImageIcon, Plus, Printer, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import type { AppState, DuplexFlip, LocalPrintSettings, Margins, Orientation, PickedFile, PriceRule, PrintType, ScaleMode } from "../../../shared/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/field";
import { run } from "@/lib/app-state";
import { Segmented } from "@/routes/scan";

/**
 * Print from PC (and Google Drive): choose files, set the options, print.
 * Files are picked and checked in main; this only holds their ids. The same
 * printer rules as the queue decide what each printer is offered for.
 */

type Rejected = { name: string; error: string };

function formatBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

function rupees(n: number): string {
  return `₹${n.toLocaleString("en-IN", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/** Pages a "1-3,5" selection covers; null when it doesn't parse or is out of range. */
export function countRanges(raw: string, pages: number): number | null {
  const compact = raw.replace(/\s+/g, "");
  if (!compact) return pages;
  if (!/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(compact)) return null;
  const set = new Set<number>();
  for (const part of compact.split(",")) {
    const [a, b] = part.split("-").map(Number) as [number, number | undefined];
    const end = b ?? a;
    if (a < 1 || end < a || end > pages) return null;
    for (let n = a; n <= end; n++) set.add(n);
  }
  return set.size;
}

export function LocalPrintDialog({
  state,
  open,
  onOpenChange,
  initial,
}: {
  state: AppState;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Files already picked (e.g. from Google Drive) when it opens. */
  initial: PickedFile[];
}) {
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [rejected, setRejected] = useState<Rejected[]>([]);
  const [picking, setPicking] = useState<"pc" | "drive" | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [rules, setRules] = useState<PriceRule[] | null>(null);

  const printers = state.printers.filter((p) => p.isEnabled);
  const [printerId, setPrinterId] = useState(printers[0]?.id ?? "");
  const printer = printers.find((p) => p.id === printerId) ?? printers[0];
  const [printType, setPrintType] = useState<PrintType>("BW");
  const [paperSize, setPaperSize] = useState("A4");
  const [copies, setCopies] = useState(1);
  const [duplex, setDuplex] = useState(false);
  const [duplexFlip, setDuplexFlip] = useState<DuplexFlip>("LONG");
  const [orientation, setOrientation] = useState<Orientation>("AUTO");
  const [scaleMode, setScaleMode] = useState<ScaleMode>("FIT");
  const [margins, setMargins] = useState<Margins>("DEFAULT");
  const [ranges, setRanges] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    setFiles(initial);
    setRejected([]);
    setRanges({});
    setCopies(state.shop?.defaultCopies ?? 1);
    void run(window.zerox.getPricing())
      .then((r) => setRules(r.rules))
      .catch(() => setRules(null));
    // Only when it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Keep the options to what the chosen printer can do.
  const paperOptions = printer?.paperSizes ?? ["A4"];
  useEffect(() => {
    if (!printer) return;
    if (!paperOptions.includes(paperSize)) setPaperSize(paperOptions.includes("A4") ? "A4" : (paperOptions[0] ?? "A4"));
    if (printType === "COLOR" && !printer.supportsColor) setPrintType("BW");
    if (duplex && !printer.supportsDuplex && !printer.manualDuplex) setDuplex(false);
  }, [printer, paperOptions, paperSize, printType, duplex]);

  const pageCounts = files.map((f) => (f.mimeType === "application/pdf" ? countRanges(ranges[f.pickId] ?? "", f.pages) : 1));
  const rangeError = pageCounts.some((n) => n === null || n === 0);
  const pages = pageCounts.reduce<number>((s, n) => s + (n ?? 0), 0);
  const rule = rules?.find((r) => r.kind === "PAGE" && r.paperSize === paperSize && r.printType === printType);
  const label = (code: string) => state.paperSizeCatalog.find((c) => c.code === code)?.label ?? code;

  async function add(from: "pc" | "drive") {
    setPicking(from);
    try {
      const picked = await run(from === "pc" ? window.zerox.localPrint.pick() : window.zerox.localPrint.pickFromDrive());
      const ok = picked.filter((p): p is PickedFile => "pickId" in p);
      setFiles((list) => [...list, ...ok].slice(0, 20));
      setRejected(picked.filter((p): p is Rejected => "error" in p));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't open the files");
    } finally {
      setPicking(null);
    }
  }

  function remove(f: PickedFile) {
    setFiles((list) => list.filter((x) => x.pickId !== f.pickId));
    void window.zerox.localPrint.remove(f.pickId);
  }

  function close(next: boolean) {
    if (submitting) return;
    if (!next) for (const f of files) void window.zerox.localPrint.remove(f.pickId);
    onOpenChange(next);
  }

  async function print() {
    if (!printer) return;
    setSubmitting(true);
    const settings: LocalPrintSettings = {
      printerId: printer.id,
      copies,
      printType,
      paperSize,
      duplex,
      duplexFlip,
      orientation,
      scaleMode,
      margins,
      pageRanges: Object.fromEntries(Object.entries(ranges).filter(([, v]) => v.trim())),
    };
    try {
      await run(window.zerox.localPrint.submit(files.map((f) => f.pickId), settings));
      toast.success(`Printing on ${printer.displayName}`, { description: "Follow it under From this PC in the print queue." });
      setFiles([]);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't print");
    } finally {
      setSubmitting(false);
    }
  }

  const canDuplex = !!printer && (printer.supportsDuplex || printer.manualDuplex) && pages > 1;
  const summary = useMemo(() => `${pages} ${pages === 1 ? "page" : "pages"} × ${copies}`, [pages, copies]);

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent title="Print from this PC" description="PDF, JPG or PNG. Nothing is uploaded; it prints straight from this computer." className="max-w-xl">
        <div className="max-h-[62vh] space-y-5 overflow-y-auto pr-1">
          <div>
            {files.length > 0 && (
              <ul className="mb-3 space-y-2">
                {files.map((f) => (
                  <li key={f.pickId} className="rounded-2xl bg-muted/60 px-3.5 py-2.5">
                    <div className="flex items-center gap-3">
                      {f.mimeType === "application/pdf" ? (
                        <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      ) : (
                        <ImageIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      )}
                      <span className="min-w-0 flex-1 truncate text-sm font-medium" title={f.name}>
                        {f.name}
                      </span>
                      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                        {f.mimeType === "application/pdf" ? `PDF · ${f.pages} p` : f.mimeType === "image/png" ? "PNG" : "JPG"} · {formatBytes(f.size)}
                        {f.source === "google_drive" && " · Drive"}
                      </span>
                      <button type="button" aria-label={`Remove ${f.name}`} onClick={() => remove(f)} className="grid size-7 place-items-center rounded-full hover:bg-muted">
                        <X className="size-3.5" aria-hidden />
                      </button>
                    </div>
                    {f.mimeType === "application/pdf" && f.pages > 1 && (
                      <div className="mt-2 flex items-center gap-2">
                        <span className="text-caption text-muted-foreground">Pages</span>
                        <Input
                          aria-label={`Pages of ${f.name}`}
                          placeholder={`All (1-${f.pages})`}
                          value={ranges[f.pickId] ?? ""}
                          onChange={(e) => setRanges((r) => ({ ...r, [f.pickId]: e.target.value }))}
                          className="h-8 max-w-[180px] text-[13px]"
                        />
                        {countRanges(ranges[f.pickId] ?? "", f.pages) === null && <span className="text-caption text-destructive">e.g. 1-3,5 (up to {f.pages})</span>}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {rejected.map((r) => (
              <p key={r.name + r.error} role="alert" className="mb-2 text-sm text-destructive">
                <span className="font-medium">{r.name}:</span> {r.error}
              </p>
            ))}
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => void add("pc")} loading={picking === "pc"} disabled={!!picking || submitting}>
                {picking !== "pc" && <Plus aria-hidden />} {files.length ? "Add files" : "Choose files"}
              </Button>
              <Button variant="ghost" onClick={() => void add("drive")} loading={picking === "drive"} disabled={!!picking || submitting}>
                {picking !== "drive" && <HardDrive aria-hidden />} From Google Drive
              </Button>
            </div>
            {picking === "drive" && <p className="mt-2 text-caption text-muted-foreground">Pick the files in your browser, then come back here.</p>}
          </div>

          {printers.length === 0 ? (
            <p className="text-sm text-destructive">Turn on a printer in Printers first.</p>
          ) : (
            <div className="grid grid-cols-2 gap-x-4 gap-y-4">
              <label className="col-span-2 grid gap-1.5 text-caption">
                Printer
                <select value={printer?.id ?? ""} onChange={(e) => setPrinterId(e.target.value)} className="h-10 rounded-full border border-input bg-card px-4 text-sm">
                  {printers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayName}
                      {p.status !== "ONLINE" && p.status !== "BUSY" ? " (offline)" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <div className="grid gap-1.5 text-caption">
                Print
                <Segmented
                  label="Print"
                  value={printType}
                  onChange={setPrintType}
                  options={[
                    { value: "BW", label: "B&W" },
                    { value: "COLOR", label: "Color", disabled: !printer?.supportsColor },
                  ]}
                />
              </div>
              <label className="grid gap-1.5 text-caption">
                Paper
                <select value={paperSize} onChange={(e) => setPaperSize(e.target.value)} className="h-9 rounded-full border border-input bg-card px-3 text-[13px]">
                  {paperOptions.map((code) => (
                    <option key={code} value={code}>
                      {label(code)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1.5 text-caption">
                Copies
                <Input type="number" min={1} max={99} value={copies} onChange={(e) => setCopies(Math.min(99, Math.max(1, Math.floor(Number(e.target.value) || 1))))} className="h-9" />
              </label>
              <div className="grid gap-1.5 text-caption">
                Orientation
                <Segmented
                  label="Orientation"
                  value={orientation}
                  onChange={setOrientation}
                  options={[
                    { value: "AUTO", label: "Auto" },
                    { value: "PORTRAIT", label: "Portrait" },
                    { value: "LANDSCAPE", label: "Landscape" },
                  ]}
                />
              </div>
              <div className="grid gap-1.5 text-caption">
                Scale
                <Segmented
                  label="Scale"
                  value={scaleMode}
                  onChange={setScaleMode}
                  options={[
                    { value: "FIT", label: "Fit" },
                    { value: "FILL", label: "Fill" },
                    { value: "ACTUAL", label: "Actual" },
                  ]}
                />
              </div>
              <div className="grid gap-1.5 text-caption">
                Margins
                <Segmented
                  label="Margins"
                  value={margins}
                  onChange={setMargins}
                  options={[
                    { value: "DEFAULT", label: "Default" },
                    { value: "NONE", label: "None" },
                  ]}
                />
              </div>
              {canDuplex && (
                <div className="grid gap-1.5 text-caption">
                  Sides
                  <Segmented
                    label="Sides"
                    value={duplex ? (duplexFlip === "SHORT" ? "short" : "long") : "single"}
                    onChange={(v) => {
                      setDuplex(v !== "single");
                      setDuplexFlip(v === "short" ? "SHORT" : "LONG");
                    }}
                    options={[
                      { value: "single", label: "One side" },
                      { value: "long", label: "Both (long)" },
                      { value: "short", label: "Both (short)" },
                    ]}
                  />
                </div>
              )}
            </div>
          )}
        </div>

        <div className="mt-6 flex items-center justify-between gap-3 border-t pt-4">
          <p className="text-sm text-muted-foreground">
            {files.length ? summary : "No files yet"}
            {files.length > 0 && rule && <span className="font-semibold text-foreground"> · {rupees(rule.price * pages * copies)}</span>}
            {files.length > 0 && rules && !rule && <span className="block text-caption text-warning-foreground">No print price for {label(paperSize)} {printType === "COLOR" ? "color" : "B&W"}: set it in Pricing to record the sale.</span>}
          </p>
          <Button onClick={() => void print()} loading={submitting} disabled={!files.length || !printer || rangeError || submitting || !!picking}>
            {!submitting && <Printer aria-hidden />} Print
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
