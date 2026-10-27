import {
  ArrowLeft,
  ArrowRight,
  Crop,
  FileText,
  FlipHorizontal2,
  FolderOpen,
  Lock,
  Printer,
  RefreshCw,
  RotateCcw,
  RotateCw,
  ScanLine,
  Trash2,
  Undo2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { FULL, clampCrop, toRotated, toUnrotated } from "../../../shared/crop";
import type { AppState, CropRect, PaperSize, PriceRule, PrintTicketOptions, PrintType, ScanMode, ScanOptions, ScanPage, ScanSource } from "../../../shared/types";
import { PrintOptions } from "@/components/print-options";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Card, EmptyState } from "@/components/ui/primitives";
import { run, useAppState } from "@/lib/app-state";
import { cn } from "@/lib/utils";

/**
 * Scan & copy at the counter, with the shop's own scanner (usually the
 * all-in-one printer's). One flow, no modes to pick first:
 *
 *   scan → check / fix the pages (rotate, crop, reorder…) → Print or Save PDF
 *
 * "ID card" scans the card-sized corner of the glass, front then back, crops
 * each to the card and prints both on one sheet. Where the scanner takes
 * paper from (glass / feeder) is set once in Settings. The whole screen fits
 * a laptop without scrolling; only a long list of pages scrolls.
 *
 * Each saved scan or printed copy is an order (specimen number, amount,
 * paid / not paid), recorded on the server even if made offline.
 */

const SIZES: PaperSize[] = ["A4", "A3"];
const DPIS = [150, 200, 300, 600, 1200];

const SOURCE_LABEL: Record<ScanSource, string> = {
  glass: "From the glass",
  feeder: "From the feeder",
  duplex: "From the feeder, both sides",
};

function rupees(n: number): string {
  return `₹${n.toLocaleString("en-IN", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/** " · ₹20" for a button label, once there's something to charge for. */
function price(rule: PriceRule | undefined, units: number): string {
  return rule && units > 0 ? ` · ${rupees(rule.price * units)}` : "";
}

export function Segmented<T extends string>({
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
            "h-7 flex-1 rounded-full px-2.5 text-[13px] transition-colors disabled:opacity-40",
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
      <p className="text-overline mb-1.5 text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}

/** The page's thumbnail, fetched again whenever its crop changes (the renderer can't read files). */
function useThumbnail(id: string, crop: CropRect | null): string | null {
  const [src, setSrc] = useState<string | null>(null);
  const key = JSON.stringify(crop);
  useEffect(() => {
    let live = true;
    void window.zerox.scan.thumbnail(id).then((r) => live && r.ok && setSrc(r.data));
    return () => {
      live = false;
    };
  }, [id, key]);
  return src;
}

type PageAction = "left" | "right" | "earlier" | "later" | "rescan" | "back" | "delete" | "crop";

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
  onAct: (what: PageAction) => void;
  onDrop: (draggedId: string) => void;
}) {
  const src = useThumbnail(page.id, page.crop);
  const [over, setOver] = useState(false);
  const quarter = page.rotation === 90 || page.rotation === 270;
  const tool = (what: PageAction, label: string, Icon: typeof Crop, disabled = false) => (
    <Button size="icon-sm" variant="ghost" className="size-7" aria-label={label} title={label} disabled={busy || disabled} onClick={() => onAct(what)}>
      <Icon aria-hidden />
    </Button>
  );
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
      className={cn("flex flex-col p-2", over && "ring-2 ring-ring")}
    >
      <button
        type="button"
        title="Crop"
        disabled={busy}
        onClick={() => onAct("crop")}
        className={cn("relative grid place-items-center overflow-hidden rounded-lg bg-muted", page.idCard ? "aspect-[1.586/1]" : "aspect-[3/4]")}
      >
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
        <span className="absolute left-1.5 top-1.5 rounded-full bg-deep px-2 py-0.5 font-mono text-[11px] font-bold text-deep-foreground">
          {index + 1}
          {page.back && " · back"}
        </span>
      </button>
      <div className="mt-1.5 flex flex-wrap items-center justify-center gap-0.5">
        {tool("left", "Rotate left", RotateCcw)}
        {tool("right", "Rotate right", RotateCw)}
        {tool("crop", "Crop", Crop)}
        {tool("earlier", "Move earlier", ArrowLeft, index === 0)}
        {tool("later", "Move later", ArrowRight, index === count - 1)}
        {tool("rescan", "Rescan this page", Undo2)}
        {canBack && !page.back && tool("back", "Scan the back of this page", FlipHorizontal2)}
        {tool("delete", "Delete page", Trash2)}
      </div>
    </Card>
  );
}

type Corner = "nw" | "ne" | "sw" | "se";

/**
 * Drag the corners (or the box) over the whole scan; what's outside is left
 * out of the PDF and the copy. Works on the page as it's shown (rotated);
 * shared/crop.ts converts to and from the scan as stored.
 */
function CropDialog({ page, onClose }: { page: ScanPage; onClose: () => void }) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [rect, setRect] = useState<CropRect>(() => toRotated(page.crop ?? FULL, page.rotation));
  const [saving, setSaving] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ mode: Corner | "move"; x: number; y: number; start: CropRect } | null>(null);
  const quarter = page.rotation === 90 || page.rotation === 270;

  useEffect(() => {
    let live = true;
    void window.zerox.scan.preview(page.id).then((r) => {
      if (!live || !r.ok || !r.data) return;
      const image = new Image();
      image.onload = () => live && setImg(image);
      image.src = r.data;
    });
    return () => {
      live = false;
    };
  }, [page.id]);

  // The whole scan, turned the way the page is shown, as large as fits.
  const size = useMemo(() => {
    if (!img) return null;
    const w = quarter ? img.height : img.width;
    const h = quarter ? img.width : img.height;
    const scale = Math.min(640 / w, 400 / h);
    return { w: Math.round(w * scale), h: Math.round(h * scale) };
  }, [img, quarter]);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !img || !size) return;
    c.width = size.w;
    c.height = size.h;
    const ctx = c.getContext("2d")!;
    ctx.save();
    ctx.translate(size.w / 2, size.h / 2);
    ctx.rotate((page.rotation * Math.PI) / 180);
    const dw = quarter ? size.h : size.w;
    const dh = quarter ? size.w : size.h;
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  }, [img, size, page.rotation, quarter]);

  function start(mode: Corner | "move") {
    return (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      drag.current = { mode, x: e.clientX, y: e.clientY, start: rect };
    };
  }

  function move(e: React.PointerEvent) {
    const d = drag.current;
    const b = box.current?.getBoundingClientRect();
    if (!d || !b) return;
    const dx = (e.clientX - d.x) / b.width;
    const dy = (e.clientY - d.y) / b.height;
    const s = d.start;
    if (d.mode === "move") return setRect(clampCrop({ ...s, x: s.x + dx, y: s.y + dy }));
    const min = 0.05;
    let [l, t, r, btm] = [s.x, s.y, s.x + s.w, s.y + s.h];
    if (d.mode === "nw" || d.mode === "sw") l = Math.min(Math.max(0, l + dx), r - min);
    if (d.mode === "ne" || d.mode === "se") r = Math.max(Math.min(1, r + dx), l + min);
    if (d.mode === "nw" || d.mode === "ne") t = Math.min(Math.max(0, t + dy), btm - min);
    if (d.mode === "sw" || d.mode === "se") btm = Math.max(Math.min(1, btm + dy), t + min);
    setRect({ x: l, y: t, w: r - l, h: btm - t });
  }

  async function apply(crop: CropRect | "auto" | null, success: string) {
    setSaving(true);
    try {
      await run(window.zerox.scan.setCrop(page.id, crop));
      toast.success(success);
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't crop this page");
    } finally {
      setSaving(false);
    }
  }

  const pct = (n: number) => `${n * 100}%`;
  const handle = (corner: Corner) => (
    <span
      onPointerDown={start(corner)}
      className={cn(
        "absolute size-4 rounded-full border-2 border-white bg-deep shadow",
        corner === "nw" && "-left-2 -top-2 cursor-nwse-resize",
        corner === "ne" && "-right-2 -top-2 cursor-nesw-resize",
        corner === "sw" && "-bottom-2 -left-2 cursor-nesw-resize",
        corner === "se" && "-bottom-2 -right-2 cursor-nwse-resize",
      )}
    />
  );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent title="Crop page" description="Drag the corners to keep only what should be saved or printed." className="max-w-[720px]">
        <div className="grid min-h-[200px] place-items-center rounded-2xl bg-muted p-3">
          {size ? (
            <div
              ref={box}
              className="relative touch-none select-none overflow-hidden"
              style={{ width: size.w, height: size.h }}
              onPointerMove={move}
              onPointerUp={() => (drag.current = null)}
            >
              <canvas ref={canvas} className="block" />
              <div
                onPointerDown={start("move")}
                className="absolute cursor-move border-2 border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]"
                style={{ left: pct(rect.x), top: pct(rect.y), width: pct(rect.w), height: pct(rect.h) }}
              >
                {handle("nw")}
                {handle("ne")}
                {handle("sw")}
                {handle("se")}
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Loading the scan…</p>
          )}
        </div>
        <div className="mt-4 flex items-center gap-2">
          {page.idCard && (
            <Button variant="ghost" size="sm" disabled={saving} onClick={() => void apply("auto", "Cropped to the card")}>
              Find the card
            </Button>
          )}
          <Button variant="ghost" size="sm" disabled={saving} onClick={() => setRect(FULL)}>
            Whole page
          </Button>
          <div className="ml-auto flex gap-2">
            <Button variant="secondary" disabled={saving} onClick={onClose}>
              Cancel
            </Button>
            <Button loading={saving} disabled={!size} onClick={() => void apply(toUnrotated(rect, page.rotation), "Page cropped")}>
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ScanScreen() {
  const state = useAppState()!;
  const { scan } = state;
  const features = state.entitlements?.features;
  const canPdf = !!features?.scan;
  const canCopy = !!features?.photocopy;
  const [cardChosen, setIdCard] = useState(false);
  const [color, setColor] = useState<PrintType>("BW");
  const [dpi, setDpi] = useState(300);
  const [paperSize, setPaperSize] = useState<PaperSize>("A4");
  const [copies, setCopies] = useState(1);
  const [duplex, setDuplex] = useState(false);
  const [printerId, setPrinterId] = useState<string>("");
  const [rules, setRules] = useState<PriceRule[] | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [cropping, setCropping] = useState<string | null>(null);
  const [ticket, setTicket] = useState<PrintTicketOptions>(() => ({ dpi: state.shop?.printDpi ? state.shop.printDpi : 1200 }));

  useEffect(() => {
    void run(window.zerox.getPricing())
      .then((r) => setRules(r.rules))
      .catch(() => setRules([]));
    if (scan.available && scan.scanners.length === 0 && !scan.listing) void window.zerox.scan.listScanners();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const busy = !!scan.busy;
  const idCard = canCopy && cardChosen;
  const source = idCard ? "glass" : scan.source;
  const scannerId = scan.defaultScannerId ?? "";
  const a3 = !!features?.a3 && state.paperSizeCatalog.some((s) => s.code === "A3");
  const sizes = SIZES.filter((s) => s === "A4" || a3);
  // An ID card copy is always on A4, one side.
  const printSize = idCard ? "A4" : paperSize;
  const printDuplex = !idCard && duplex;

  const printers = useMemo(
    () =>
      state.printers.filter(
        (p) =>
          p.isEnabled &&
          p.paperSizes.includes(printSize) &&
          (color === "BW" || p.supportsColor) &&
          (!printDuplex || p.supportsDuplex || p.manualDuplex),
      ),
    [state.printers, printSize, color, printDuplex],
  );
  const printer = printers.find((p) => p.id === printerId) ?? printers[0] ?? null;

  const pages = scan.pages;
  const sheets = idCard ? Math.ceil(pages.length / 2) : pages.length;
  const copyRule = rules?.find((r) => r.kind === "COPY" && r.paperSize === printSize && r.printType === color);
  const showPdf = canPdf && !idCard;
  const colorCopyLocked = color === "COLOR" && !features?.color;
  const croppingPage = pages.find((p) => p.id === cropping) ?? null;

  function options(): ScanOptions {
    const scanMode: ScanMode = color === "COLOR" ? "color" : "gray";
    return { scannerId, source, mode: scanMode, dpi, paperSize: printSize, idCard };
  }

  async function act(fn: () => Promise<unknown>, success?: string) {
    try {
      await fn();
      if (success) toast.success(success);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  function pageAct(page: ScanPage, index: number, what: PageAction) {
    const s = window.zerox.scan;
    if (what === "crop") return setCropping(page.id);
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
      () => run(window.zerox.scan.copy({ printerId: printer.id, printType: color, paperSize: printSize, copies, duplex: printDuplex, idCard, ticket })),
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

  if (!canPdf && !canCopy) {
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

  const colorControl = (
    <Segmented
      label="Color"
      value={color}
      disabled={busy}
      onChange={setColor}
      options={[
        { value: "BW", label: "B&W" },
        // A color PDF is always allowed; a color copy needs the plan's color feature.
        { value: "COLOR", label: "Color", disabled: !showPdf && !features?.color },
      ]}
    />
  );

  return (
    <div className="flex h-[calc(100dvh-4rem)] flex-col">
      <Header>
        {pages.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => setConfirmClear(true)} disabled={busy}>
            New scan
          </Button>
        )}
      </Header>

      <div className="grid min-h-0 flex-1 grid-cols-[272px_1fr] gap-4">
        <Card className="flex min-h-0 flex-col gap-3.5 overflow-y-auto p-4">
          <Group label="Scanner">
            <div className="flex items-center gap-1">
              {scan.scanners.length === 0 ? (
                <p className="min-w-0 flex-1 text-[13px] text-muted-foreground">
                  {scan.listing ? "Looking for scanners…" : "No scanner found. Turn the printer on, then look again."}
                </p>
              ) : (
                <select
                  value={scannerId}
                  disabled={busy}
                  onChange={(e) => void act(() => run(window.zerox.scan.setDefaultScanner(e.target.value)))}
                  className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-card px-2 text-[13px]"
                >
                  {scan.scanners.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.driver.toUpperCase()})
                    </option>
                  ))}
                </select>
              )}
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Look for scanners again"
                title="Look for scanners again"
                loading={scan.listing}
                disabled={busy}
                onClick={() => void act(() => run(window.zerox.scan.listScanners()))}
              >
                {!scan.listing && <RefreshCw aria-hidden />}
              </Button>
            </div>
          </Group>

          {canCopy && (
            <Group label="What's on the scanner">
              <Segmented
                label="What's on the scanner"
                value={idCard ? "card" : "document"}
                disabled={busy || pages.length > 0}
                onChange={(v) => setIdCard(v === "card")}
                options={[
                  { value: "document", label: "Document" },
                  { value: "card", label: "ID card" },
                ]}
              />
            </Group>
          )}

          {idCard ? (
            <>
              <Group label="Color">{colorControl}</Group>
              <p className="rounded-xl bg-muted px-3 py-2 text-[13px] leading-snug">
                Card face down in the <span className="font-medium">top corner of the glass</span>. Scan the front, flip it, scan the back.
              </p>
            </>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <Group label="Color">{colorControl}</Group>
              <Group label="Paper">
                <Segmented label="Paper size" value={paperSize} disabled={busy} onChange={setPaperSize} options={sizes.map((s) => ({ value: s, label: s }))} />
              </Group>
            </div>
          )}

          <Group label="Quality">
            <select value={dpi} disabled={busy} onChange={(e) => setDpi(Number(e.target.value))} className="h-8 w-full rounded-lg border border-input bg-card px-2 text-[13px]">
              {DPIS.map((d) => (
                <option key={d} value={d}>
                  {d} dpi{d === 300 ? " (recommended)" : d === 600 ? " (slow, large file)" : d === 1200 ? " (very slow, very large file)" : ""}
                </option>
              ))}
            </select>
          </Group>

          <div className="mt-auto space-y-1.5 border-t pt-3.5">
            <Button className="w-full" variant="secondary" loading={scan.busy === "scanning"} disabled={busy || !scannerId} onClick={() => void act(() => run(window.zerox.scan.start(options())))}>
              {scan.busy !== "scanning" && <ScanLine aria-hidden />} {scan.busy === "scanning" ? "Scanning…" : nextScanLabel}
            </Button>
            <div className="flex items-baseline justify-between gap-2 px-1 text-caption text-muted-foreground">
              {idCard ? (
                <span>ID card: from the glass</span>
              ) : (
                <Link to="/settings" className="truncate hover:text-foreground hover:underline" title="Change in Settings">
                  {SOURCE_LABEL[source]} · change
                </Link>
              )}
              <span className="shrink-0">
                {idCard ? `${sheets} ${sheets === 1 ? "card" : "cards"}` : `${sheets} ${sheets === 1 ? "page" : "pages"}`}
              </span>
            </div>
          </div>
        </Card>

        <div className="flex min-h-0 flex-col gap-3">
          {scan.error && <p className="rounded-2xl bg-destructive/10 px-4 py-2.5 text-sm text-destructive">{scan.error}</p>}
          {scan.lastSaved && <Saved state={state} />}
          <Outbox state={state} />

          <div className="min-h-0 flex-1 overflow-y-auto">
            {pages.length === 0 ? (
              <Card className="grid h-full place-items-center">
                <EmptyState
                  icon={ScanLine}
                  title="Nothing scanned yet"
                  description={
                    idCard
                      ? "Scan the front of the card, then the back. Both print on one sheet, cropped to the card."
                      : "Press Scan. Then print the pages or save them as a PDF. Click a page to crop it."
                  }
                />
              </Card>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2.5">
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
          </div>

          <Card className="space-y-2.5 p-3">
            {canCopy && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <div className="flex min-w-0 items-center gap-2 text-sm">
                  <Printer className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  {printers.length === 0 ? (
                    <span className="text-destructive">
                      No turned-on printer can print this. <Link to="/printers" className="underline">Check printers</Link>
                    </span>
                  ) : printers.length === 1 ? (
                    <span className="truncate">{printer!.displayName}</span>
                  ) : (
                    <select
                      value={printer?.id ?? ""}
                      disabled={busy}
                      onChange={(e) => setPrinterId(e.target.value)}
                      className="h-8 max-w-48 rounded-lg border border-input bg-card px-2 text-[13px]"
                    >
                      {printers.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.displayName}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-sm text-muted-foreground">Copies</span>
                  <Button size="icon-sm" variant="secondary" className="size-7" aria-label="Fewer copies" disabled={busy || copies <= 1} onClick={() => setCopies((c) => c - 1)}>
                    −
                  </Button>
                  <span className="w-7 text-center font-mono tabular-nums">{copies}</span>
                  <Button size="icon-sm" variant="secondary" className="size-7" aria-label="More copies" disabled={busy || copies >= 99} onClick={() => setCopies((c) => c + 1)}>
                    +
                  </Button>
                </div>
                {!idCard && features?.duplex && (
                  <div className="w-48">
                    <Segmented
                      label="Sides"
                      value={duplex ? "double" : "single"}
                      disabled={busy}
                      onChange={(v) => setDuplex(v === "double")}
                      options={[
                        { value: "single", label: "One side" },
                        { value: "double", label: "Both sides" },
                      ]}
                    />
                  </div>
                )}
              </div>
            )}
            {canCopy && printer && (
              <PrintOptions printerId={printer.id} value={ticket} onChange={setTicket} defaultDpi={state.shop?.printDpi ?? 600} disabled={busy} />
            )}
            <div className={cn("grid gap-2", canCopy && showPdf ? "grid-cols-2" : "grid-cols-1")}>
              {canCopy && (
                <Button
                  loading={scan.busy === "printing"}
                  disabled={busy || pages.length === 0 || !copyRule || !printer || colorCopyLocked || (idCard && pages.length % 2 === 1)}
                  onClick={() => void copy()}
                >
                  {scan.busy !== "printing" && <Printer aria-hidden />}
                  {scan.busy === "printing" ? "Printing…" : `Print${price(copyRule, sheets * copies)}`}
                </Button>
              )}
              {showPdf && (
                <Button variant={canCopy ? "secondary" : "primary"} loading={scan.busy === "saving"} disabled={busy || pages.length === 0} onClick={() => void save()}>
                  {scan.busy !== "saving" && <FileText aria-hidden />} Save PDF
                </Button>
              )}
            </div>
            {canCopy && colorCopyLocked ? (
              <p className="px-1 text-caption text-destructive">Color copies aren&apos;t in your plan. Choose B&amp;W to print.</p>
            ) : (
              canCopy &&
              rules &&
              !copyRule && (
                <p className="px-1 text-caption text-destructive">
                  Set a photocopy price for {printSize} {color === "COLOR" ? "color" : "black & white"} in{" "}
                  <Link to="/pricing" className="underline">
                    Pricing
                  </Link>{" "}
                  first.
                </p>
              )
            )}
          </Card>
        </div>
      </div>

      {croppingPage && <CropDialog key={croppingPage.id} page={croppingPage} onClose={() => setCropping(null)} />}

      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="Start a new scan?"
        description="The pages scanned so far are removed. Anything already saved or printed stays as it is."
        confirmLabel="Remove pages"
        destructive
        onConfirm={() => act(() => run(window.zerox.scan.clear()))}
      />
    </div>
  );
}

function Header({ children }: { children?: React.ReactNode }) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <div>
        <h1 className="text-title">Scan & copy</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">Scan, then print a copy or save it as a PDF. Each one is an order.</p>
      </div>
      {children}
    </div>
  );
}

function Saved({ state }: { state: AppState }) {
  const saved = state.scan.lastSaved!;
  return (
    <Card className="flex items-center gap-3 border-0 bg-deep px-4 py-2.5 text-deep-foreground">
      <FileText className="size-5 shrink-0 text-lime" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{saved.specimenRef ? `Saved as ${saved.specimenRef}` : "Saved"}</p>
        <p className="truncate text-caption text-deep-foreground/70" title={saved.path}>
          {saved.path}
        </p>
      </div>
      <Button size="sm" variant="lime" onClick={() => void window.zerox.scan.open("file")}>
        Open file
      </Button>
      <Button size="sm" variant="ghost" className="text-deep-foreground hover:bg-deep-foreground/10" onClick={() => void window.zerox.scan.open("folder")}>
        <FolderOpen aria-hidden /> Folder
      </Button>
    </Card>
  );
}

function Outbox({ state }: { state: AppState }) {
  const waiting = state.scan.outbox;
  const [syncing, setSyncing] = useState(false);
  if (waiting.length === 0) return null;
  const reason =
    waiting.find((o) => o.error)?.error ??
    waiting.find((o) => o.retryReason)?.retryReason ??
    "They're saved on this computer and will be recorded as soon as Zerox Buddy is online.";

  async function tryNow() {
    setSyncing(true);
    try {
      await window.zerox.scan.sync();
      const left = (await run(window.zerox.getState())).scan.outbox;
      if (left.length === 0) toast.success("All orders recorded");
      else toast.error(left.find((o) => o.error)?.error ?? left.find((o) => o.retryReason)?.retryReason ?? "Still not recorded. Zerox Buddy will keep trying.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't try again");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <Card className="flex items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {waiting.length} {waiting.length === 1 ? "order" : "orders"} not recorded yet
        </p>
        <p className="truncate text-caption text-muted-foreground" title={reason}>
          {reason}
        </p>
      </div>
      <Button size="sm" variant="secondary" loading={syncing} onClick={() => void tryNow()}>
        {!syncing && <RefreshCw aria-hidden />} Try now
      </Button>
    </Card>
  );
}
