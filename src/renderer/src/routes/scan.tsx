import {
  ArrowLeft,
  ArrowRight,
  Copy,
  FileText,
  FolderOpen,
  IdCard,
  Lock,
  Printer,
  RefreshCw,
  RotateCcw,
  RotateCw,
  ScanLine,
  Trash2,
  Undo2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import type { AppState, PaperSize, PriceRule, PrintType, ScanMode, ScanOptions, ScanPage, ScanSource } from "../../../shared/types";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Card, EmptyState } from "@/components/ui/primitives";
import { run, useAppState } from "@/lib/app-state";
import { cn } from "@/lib/utils";

/**
 * Scan & copy at the counter, with the shop's own scanner (usually the
 * all-in-one printer's). Three modes share one page session:
 *
 *   pdf     scan → check / fix the pages → save a PDF on this computer
 *   copy    scan → check → print on one of the shop's printers
 *   idCard  front and back of a card from the glass → both on one sheet
 *
 * Each saved scan or printed copy is an order (specimen number, amount,
 * paid / not paid), recorded on the server even if made offline.
 */

type Mode = "pdf" | "copy" | "idCard";

const SIZES: PaperSize[] = ["A4", "A3"];
const DPIS = [150, 200, 300, 600];

function rupees(n: number): string {
  return `₹${n.toLocaleString("en-IN", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

function Segmented<T extends string>({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; disabled?: boolean }[];
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-full bg-muted p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={disabled || o.disabled}
          onClick={() => onChange(o.value)}
          className={cn(
            "h-8 flex-1 rounded-full px-3 text-[13px] transition-colors disabled:opacity-40",
            value === o.value ? "bg-card font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-overline mb-2 text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}

/** The page's thumbnail, fetched once per page id (the renderer can't read files). */
function useThumbnail(id: string): string | null {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void window.zerox.scan.thumbnail(id).then((r) => live && r.ok && setSrc(r.data));
    return () => {
      live = false;
    };
  }, [id]);
  return src;
}

function PageCard({
  page,
  index,
  count,
  busy,
  canBack,
  onAct,
  onDrop,
}: {
  page: ScanPage;
  index: number;
  count: number;
  busy: boolean;
  canBack: boolean;
  onAct: (what: "left" | "right" | "earlier" | "later" | "rescan" | "back" | "delete") => void;
  onDrop: (draggedId: string) => void;
}) {
  const src = useThumbnail(page.id);
  const [over, setOver] = useState(false);
  const quarter = page.rotation === 90 || page.rotation === 270;
  return (
    <Card
      draggable={!busy}
      onDragStart={(e) => e.dataTransfer.setData("text/plain", page.id)}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const id = e.dataTransfer.getData("text/plain");
        if (id && id !== page.id) onDrop(id);
      }}
      className={cn("flex flex-col p-3", over && "ring-2 ring-ring")}
    >
      <div className="relative grid aspect-[3/4] place-items-center overflow-hidden rounded-lg bg-muted">
        {src ? (
          <img
            src={src}
            alt={`Page ${index + 1}`}
            className={cn("max-h-full max-w-full object-contain transition-transform", quarter && "max-h-[75%] max-w-[133%]")}
            style={{ transform: `rotate(${page.rotation}deg)` }}
          />
        ) : (
          <ScanLine className="size-6 text-muted-foreground" aria-hidden />
        )}
        <span className="absolute left-2 top-2 rounded-full bg-deep px-2 py-0.5 font-mono text-[11px] font-bold text-deep-foreground">
          {index + 1}
          {page.back && " · back"}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-0.5">
        <Button size="icon-sm" variant="ghost" aria-label="Rotate left" disabled={busy} onClick={() => onAct("left")}>
          <RotateCcw aria-hidden />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Rotate right" disabled={busy} onClick={() => onAct("right")}>
          <RotateCw aria-hidden />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Move earlier" disabled={busy || index === 0} onClick={() => onAct("earlier")}>
          <ArrowLeft aria-hidden />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Move later" disabled={busy || index === count - 1} onClick={() => onAct("later")}>
          <ArrowRight aria-hidden />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Delete page" disabled={busy} onClick={() => onAct("delete")}>
          <Trash2 aria-hidden />
        </Button>
      </div>
      <div className="mt-1 flex justify-center gap-1">
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAct("rescan")}>
          <Undo2 aria-hidden /> Rescan
        </Button>
        {canBack && !page.back && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAct("back")}>
            Scan back
          </Button>
        )}
      </div>
    </Card>
  );
}

export function ScanScreen() {
  const state = useAppState()!;
  const { scan } = state;
  const features = state.entitlements?.features;
  const allowed: Record<Mode, boolean> = { pdf: !!features?.scan, copy: !!features?.photocopy, idCard: !!features?.photocopy };
  const [mode, setMode] = useState<Mode>(allowed.pdf ? "pdf" : "copy");
  const [source, setSource] = useState<ScanSource>("glass");
  const [color, setColor] = useState<PrintType>("BW");
  const [dpi, setDpi] = useState(300);
  const [paperSize, setPaperSize] = useState<PaperSize>("A4");
  const [copies, setCopies] = useState(1);
  const [duplex, setDuplex] = useState(false);
  const [printerId, setPrinterId] = useState<string>("");
  const [rules, setRules] = useState<PriceRule[] | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    void run(window.zerox.getPricing())
      .then((r) => setRules(r.rules))
      .catch(() => setRules([]));
    if (scan.available && scan.scanners.length === 0 && !scan.listing) void window.zerox.scan.listScanners();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const busy = !!scan.busy;
  const idCard = mode === "idCard";
  const scannerId = scan.defaultScannerId ?? "";
  const a3 = !!features?.a3 && state.paperSizeCatalog.some((s) => s.code === "A3");
  const sizes = SIZES.filter((s) => s === "A4" || a3);

  const printers = useMemo(
    () =>
      state.printers.filter(
        (p) =>
          p.isEnabled &&
          p.paperSizes.includes(paperSize) &&
          (color === "BW" || p.supportsColor) &&
          (!duplex || p.supportsDuplex || p.manualDuplex),
      ),
    [state.printers, paperSize, color, duplex],
  );
  const printer = printers.find((p) => p.id === printerId) ?? printers[0] ?? null;

  const pages = scan.pages;
  const sheets = idCard ? Math.ceil(pages.length / 2) : pages.length;
  const priceKind = mode === "pdf" ? "SCAN" : "COPY";
  const rule = rules?.find((r) => r.kind === priceKind && r.paperSize === (idCard ? "A4" : paperSize) && r.printType === color);
  const estimate = rule ? rule.price * sheets * (mode === "pdf" ? 1 : copies) : null;

  function options(): ScanOptions {
    const scanMode: ScanMode = color === "COLOR" ? "color" : "gray";
    return { scannerId, source: idCard ? "glass" : source, mode: scanMode, dpi, paperSize: idCard ? "A4" : paperSize, idCard };
  }

  async function act(fn: () => Promise<unknown>, success?: string) {
    try {
      await fn();
      if (success) toast.success(success);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  function pageAct(page: ScanPage, index: number, what: Parameters<React.ComponentProps<typeof PageCard>["onAct"]>[0]) {
    const s = window.zerox.scan;
    if (what === "left" || what === "right") return void act(() => run(s.rotate(page.id, what)));
    if (what === "earlier") return void act(() => run(s.move(page.id, index - 1)));
    if (what === "later") return void act(() => run(s.move(page.id, index + 1)));
    if (what === "delete") return void act(() => run(s.remove(page.id)));
    if (what === "rescan") return void act(() => run(s.rescan(options(), page.id)));
    return void act(() => run(s.back(options(), page.id)));
  }

  async function save() {
    await act(() => run(window.zerox.scan.save({ printType: color, paperSize })), "Scan saved");
  }

  async function copy() {
    if (!printer) return;
    await act(
      () => run(window.zerox.scan.copy({ printerId: printer.id, printType: color, paperSize: idCard ? "A4" : paperSize, copies, duplex: !idCard && duplex, idCard })),
      "Photocopy printed",
    );
  }

  if (!scan.available) {
    return (
      <>
        <Header />
        <Card>
          <EmptyState
            icon={ScanLine}
            title="Scanning needs the 64-bit Zerox Buddy"
            description="This computer has the 32-bit version, which can't scan. Install the 64-bit version on a 64-bit Windows computer to scan and photocopy."
          />
        </Card>
      </>
    );
  }

  if (!allowed.pdf && !allowed.copy) {
    return (
      <>
        <Header />
        <Card>
          <EmptyState
            icon={Lock}
            title="Scan & copy isn't in your plan"
            description="Upgrade to scan documents to PDF and make photocopies at the counter."
            action={
              <Link to="/subscription">
                <Button>See plans</Button>
              </Link>
            }
          />
        </Card>
      </>
    );
  }

  const nextScanLabel = idCard
    ? pages.length % 2 === 0
      ? pages.length === 0
        ? "Scan front"
        : "Scan next card's front"
      : "Scan back"
    : pages.length === 0
      ? "Scan"
      : source === "glass"
        ? "Scan next page"
        : "Scan more";

  return (
    <>
      <Header>
        {pages.length > 0 && (
          <Button variant="ghost" onClick={() => setConfirmClear(true)} disabled={busy}>
            New scan
          </Button>
        )}
      </Header>

      <div role="tablist" aria-label="What to do" className="mb-5 flex gap-2">
        {(
          [
            { value: "pdf", label: "Scan to PDF", icon: FileText },
            { value: "copy", label: "Photocopy", icon: Copy },
            { value: "idCard", label: "ID card copy", icon: IdCard },
          ] as const
        ).map((t) => (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={mode === t.value}
            disabled={!allowed[t.value] || busy}
            onClick={() => setMode(t.value)}
            className={cn(
              "flex h-10 items-center gap-2 rounded-full px-4 text-sm transition-colors disabled:opacity-40",
              mode === t.value ? "bg-deep text-deep-foreground" : "bg-muted text-muted-foreground hover:text-foreground",
            )}
          >
            <t.icon className="size-4" aria-hidden /> {t.label}
            {!allowed[t.value] && <Lock className="size-3.5" aria-hidden />}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-[300px_1fr] items-start gap-5">
        <Card className="space-y-5 p-5">
          <Group label="Scanner">
            {scan.scanners.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {scan.listing ? "Looking for scanners…" : "No scanner found. Turn the printer on, check its cable or Wi-Fi, then look again."}
              </p>
            ) : (
              <select
                value={scannerId}
                disabled={busy}
                onChange={(e) => void act(() => run(window.zerox.scan.setDefaultScanner(e.target.value)))}
                className="h-9 w-full rounded-lg border border-input bg-card px-2 text-sm"
              >
                {scan.scanners.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.driver.toUpperCase()})
                  </option>
                ))}
              </select>
            )}
            <Button size="sm" variant="ghost" className="mt-1.5" loading={scan.listing} disabled={busy} onClick={() => void act(() => run(window.zerox.scan.listScanners()))}>
              {!scan.listing && <RefreshCw aria-hidden />} Look again
            </Button>
          </Group>

          {idCard ? (
            <p className="rounded-xl bg-muted px-3.5 py-3 text-sm">
              Put the card face down in the <span className="font-medium">top corner of the glass</span> (where the arrow mark is). Scan the
              front, turn the card over in the same place, then scan the back.
            </p>
          ) : (
            <Group label="Paper in the scanner">
              <Segmented
                label="Source"
                value={source}
                disabled={busy}
                onChange={setSource}
                options={[
                  { value: "glass", label: "Glass" },
                  { value: "feeder", label: "Feeder" },
                  { value: "duplex", label: "Feeder, 2 sides" },
                ]}
              />
            </Group>
          )}

          <Group label={mode === "pdf" ? "Scan in" : "Copy in"}>
            <Segmented
              label="Color"
              value={color}
              disabled={busy}
              onChange={setColor}
              options={[
                { value: "BW", label: "Black & White" },
                { value: "COLOR", label: "Color", disabled: mode !== "pdf" && !features?.color },
              ]}
            />
          </Group>

          {!idCard && (
            <Group label="Paper size">
              <Segmented label="Paper size" value={paperSize} disabled={busy} onChange={setPaperSize} options={sizes.map((s) => ({ value: s, label: s }))} />
            </Group>
          )}

          <Group label="Quality">
            <select value={dpi} disabled={busy} onChange={(e) => setDpi(Number(e.target.value))} className="h-9 w-full rounded-lg border border-input bg-card px-2 text-sm">
              {DPIS.map((d) => (
                <option key={d} value={d}>
                  {d} dpi{d === 300 ? " (recommended)" : d === 600 ? " (slow, large file)" : ""}
                </option>
              ))}
            </select>
          </Group>

          {mode !== "pdf" && (
            <>
              <Group label="Print on">
                {printers.length === 0 ? (
                  <p className="text-sm text-destructive">
                    No turned-on printer can print this. <Link to="/printers" className="underline">Check printers</Link>
                  </p>
                ) : (
                  <select
                    value={printer?.id ?? ""}
                    disabled={busy}
                    onChange={(e) => setPrinterId(e.target.value)}
                    className="h-9 w-full rounded-lg border border-input bg-card px-2 text-sm"
                  >
                    {printers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.displayName}
                      </option>
                    ))}
                  </select>
                )}
              </Group>
              <Group label="Copies">
                <div className="flex items-center gap-2">
                  <Button size="icon-sm" variant="secondary" aria-label="Fewer copies" disabled={busy || copies <= 1} onClick={() => setCopies((c) => c - 1)}>
                    −
                  </Button>
                  <span className="w-10 text-center font-mono text-lg tabular-nums">{copies}</span>
                  <Button size="icon-sm" variant="secondary" aria-label="More copies" disabled={busy || copies >= 99} onClick={() => setCopies((c) => c + 1)}>
                    +
                  </Button>
                </div>
              </Group>
              {!idCard && (
                <Group label="Sides">
                  <Segmented
                    label="Sides"
                    value={duplex ? "double" : "single"}
                    disabled={busy || !features?.duplex}
                    onChange={(v) => setDuplex(v === "double")}
                    options={[
                      { value: "single", label: "One side" },
                      { value: "double", label: "Both sides" },
                    ]}
                  />
                </Group>
              )}
            </>
          )}

          <div className="space-y-2 border-t pt-5">
            <Button className="w-full" variant="secondary" loading={scan.busy === "scanning"} disabled={busy || !scannerId} onClick={() => void act(() => run(window.zerox.scan.start(options())))}>
              {scan.busy !== "scanning" && <ScanLine aria-hidden />} {scan.busy === "scanning" ? "Scanning…" : nextScanLabel}
            </Button>
            <div className="flex items-baseline justify-between px-1 pt-1">
              <span className="text-sm text-muted-foreground">
                {sheets} {sheets === 1 ? "page" : "pages"}
                {mode !== "pdf" && ` × ${copies} ${copies === 1 ? "copy" : "copies"}`}
              </span>
              <span className="font-display text-lg font-bold tabular-nums">
                {estimate !== null ? rupees(estimate) : rules ? "No price set" : "…"}
              </span>
            </div>
            {rules && !rule && (
              <p className="px-1 text-caption text-destructive">
                Set a {mode === "pdf" ? "scan" : "photocopy"} price for {idCard ? "A4" : paperSize} {color === "COLOR" ? "color" : "black & white"} in{" "}
                <Link to="/pricing" className="underline">
                  Pricing
                </Link>{" "}
                first.
              </p>
            )}
            {mode === "pdf" ? (
              <Button className="w-full" loading={scan.busy === "saving"} disabled={busy || pages.length === 0 || !rule} onClick={() => void save()}>
                {scan.busy !== "saving" && <FileText aria-hidden />} Save PDF
              </Button>
            ) : (
              <Button
                className="w-full"
                loading={scan.busy === "printing"}
                disabled={busy || pages.length === 0 || !rule || !printer || (idCard && pages.length % 2 === 1)}
                onClick={() => void copy()}
              >
                {scan.busy !== "printing" && <Printer aria-hidden />} {scan.busy === "printing" ? "Printing…" : "Print copy"}
              </Button>
            )}
          </div>
        </Card>

        <div className="min-w-0 space-y-4">
          {scan.error && <p className="rounded-2xl bg-destructive/10 p-4 text-sm text-destructive">{scan.error}</p>}
          {scan.lastSaved && <Saved state={state} />}
          {pages.length === 0 ? (
            <Card>
              <EmptyState
                icon={ScanLine}
                title="Nothing scanned yet"
                description={
                  idCard
                    ? "Scan the front of the card, then the back. Both print on one sheet."
                    : "Put the pages on the glass or in the feeder and press Scan. You can rotate, reorder, delete or rescan pages before you save or print."
                }
              />
            </Card>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-3">
              {pages.map((p, i) => (
                <PageCard
                  key={p.id}
                  page={p}
                  index={i}
                  count={pages.length}
                  busy={busy}
                  canBack={!idCard && source === "glass"}
                  onAct={(what) => pageAct(p, i, what)}
                  onDrop={(draggedId) => void act(() => run(window.zerox.scan.move(draggedId, i)))}
                />
              ))}
            </div>
          )}
          <Outbox state={state} />
        </div>
      </div>

      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="Start a new scan?"
        description="The pages scanned so far are removed. Anything already saved or printed stays as it is."
        confirmLabel="Remove pages"
        destructive
        onConfirm={() => act(() => run(window.zerox.scan.clear()))}
      />
    </>
  );
}

function Header({ children }: { children?: React.ReactNode }) {
  return (
    <div className="mb-6 flex items-end justify-between gap-4">
      <div>
        <h1 className="text-title">Scan & copy</h1>
        <p className="mt-1 text-[15px] text-muted-foreground">Scan documents to PDF or make photocopies with your scanner. Each one is an order.</p>
      </div>
      {children}
    </div>
  );
}

function Saved({ state }: { state: AppState }) {
  const saved = state.scan.lastSaved!;
  return (
    <Card className="flex items-center gap-4 border-0 bg-deep p-4 text-deep-foreground">
      <FileText className="size-6 shrink-0 text-lime" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{saved.specimenRef ? `Saved as ${saved.specimenRef}` : "Saved"}</p>
        <p className="truncate text-sm text-deep-foreground/70" title={saved.path}>
          {saved.path}
        </p>
      </div>
      <Button size="sm" variant="lime" onClick={() => void window.zerox.scan.open("file")}>
        Open file
      </Button>
      <Button size="sm" variant="ghost" className="text-deep-foreground hover:bg-deep-foreground/10" onClick={() => void window.zerox.scan.open("folder")}>
        <FolderOpen aria-hidden /> Open folder
      </Button>
    </Card>
  );
}

function Outbox({ state }: { state: AppState }) {
  const waiting = state.scan.outbox;
  const [syncing, setSyncing] = useState(false);
  if (waiting.length === 0) return null;
  const refused = waiting.find((o) => o.error);
  return (
    <Card className="flex items-center gap-4 p-4">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {waiting.length} {waiting.length === 1 ? "order" : "orders"} not recorded yet
        </p>
        <p className="text-sm text-muted-foreground">
          {refused ? refused.error : "They're saved on this computer and will be recorded as soon as Zerox Buddy is online."}
        </p>
      </div>
      <Button
        size="sm"
        variant="secondary"
        loading={syncing}
        onClick={async () => {
          setSyncing(true);
          await window.zerox.scan.sync();
          setSyncing(false);
        }}
      >
        {!syncing && <RefreshCw aria-hidden />} Try now
      </Button>
    </Card>
  );
}
