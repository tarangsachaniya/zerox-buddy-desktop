import { Check, Download, ImagePlus, Inbox, Link2, Lock, Pencil, Printer, SquareUser, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { initialCrop, outputPixelSize, reshapeCrop, type PhotoCrop } from "../../../shared/passport/crop";
import type { Margins } from "../../../shared/passport/layout";
import type { PassportPaperCode } from "../../../shared/passport/paper";
import { layoutSheet, type PassportSheetSettings } from "../../../shared/passport/sheet";
import type { IncomingPhoto, LoadedPhoto, PassportPreset, PriceRule, PrintTicketOptions, PrintType } from "../../../shared/types";
import { CropEditor } from "@/components/passport/crop-editor";
import { SheetPreview } from "@/components/passport/sheet-preview";
import { PrintOptions } from "@/components/print-options";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Badge, Card, EmptyState } from "@/components/ui/primitives";
import { run, useAppState } from "@/lib/app-state";
import { decodePhoto, renderApproved, type EditablePhoto } from "@/lib/passport-render";
import { Segmented } from "@/routes/scan";

/**
 * Passport Photo Studio: photo → crop → sheet → PDF or print. Sizes are in
 * millimetres and photos always print at exactly that size; the sheet is laid
 * out by the same engine (shared/passport) that builds the PDF, with this
 * printer's real margins, so the preview is what comes out.
 */

const CUSTOM = "custom";

type Fields = {
  photoW: string;
  photoH: string;
  paper: PassportPaperCode;
  customW: string;
  customH: string;
  orientation: "PORTRAIT" | "LANDSCAPE";
  mt: string;
  mr: string;
  mb: string;
  ml: string;
  gx: string;
  gy: string;
  border: boolean;
  borderT: string;
  align: "CENTER" | "TOP_LEFT";
  mode: "AUTO_FIT" | "TARGET";
  copies: string;
};

const DEFAULT_FIELDS: Fields = {
  photoW: "35",
  photoH: "45",
  paper: "A4",
  customW: "",
  customH: "",
  orientation: "PORTRAIT",
  mt: "5",
  mr: "5",
  mb: "5",
  ml: "5",
  gx: "2",
  gy: "2",
  border: true,
  borderT: "0.2",
  align: "CENTER",
  mode: "AUTO_FIT",
  copies: "8",
};

function fromPreset(p: PassportPreset): Fields {
  return {
    photoW: String(p.photoWidthMm),
    photoH: String(p.photoHeightMm),
    paper: p.paperSize,
    customW: p.customPaperWidthMm == null ? "" : String(p.customPaperWidthMm),
    customH: p.customPaperHeightMm == null ? "" : String(p.customPaperHeightMm),
    orientation: p.orientation,
    mt: String(p.marginTopMm),
    mr: String(p.marginRightMm),
    mb: String(p.marginBottomMm),
    ml: String(p.marginLeftMm),
    gx: String(p.gapXMm),
    gy: String(p.gapYMm),
    border: p.borderEnabled,
    borderT: String(p.borderThicknessMm),
    align: p.align,
    mode: p.layoutMode,
    copies: String(p.defaultCopies),
  };
}

const n = (s: string) => (s.trim() === "" ? Number.NaN : Number(s.replace(",", ".")));

function toSettings(f: Fields): PassportSheetSettings {
  return {
    paperSize: f.paper,
    customPaper: f.paper === "CUSTOM" ? { widthMm: n(f.customW), heightMm: n(f.customH) } : null,
    orientation: f.orientation,
    photo: { widthMm: n(f.photoW), heightMm: n(f.photoH) },
    margins: { top: n(f.mt), right: n(f.mr), bottom: n(f.mb), left: n(f.ml) },
    gapXMm: n(f.gx),
    gapYMm: n(f.gy),
    align: f.align,
    mode: f.mode,
    copies: n(f.copies),
    border: { enabled: f.border, thicknessMm: n(f.borderT) },
  };
}

function rupees(v: number): string {
  return `₹${v.toLocaleString("en-IN", { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

const fmt = (v: number) => String(Math.round(v * 10) / 10);

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-overline mb-1.5 text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}

function MmField({ label, value, onChange, disabled }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <label className="grid gap-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <input
        inputMode="decimal"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-full rounded-lg border border-input bg-card px-2 font-mono text-[13px] tabular-nums disabled:opacity-50"
      />
    </label>
  );
}

type Approved = { photoId: string; previewUrl: string; sig: string };

export function PassportScreen() {
  const state = useAppState()!;
  const location = useLocation();
  const navigate = useNavigate();
  const enabled = !!state.entitlements?.features.passport_photo;
  const presets = state.passportPresets;

  const [presetId, setPresetId] = useState<string>(() => presets[0]?.id ?? CUSTOM);
  const preset = presets.find((p) => p.id === presetId) ?? null;
  const [fields, setFields] = useState<Fields>(() => (presets[0] ? fromPreset(presets[0]) : DEFAULT_FIELDS));
  const set = <K extends keyof Fields>(key: K, value: Fields[K]) => setFields((f) => ({ ...f, [key]: value }));

  const [loaded, setLoaded] = useState<LoadedPhoto | null>(null);
  const [photo, setPhoto] = useState<EditablePhoto | null>(null);
  const [crop, setCrop] = useState<PhotoCrop | null>(null);
  const [step, setStep] = useState<"photo" | "crop" | "sheet">("photo");
  const [approved, setApproved] = useState<Approved | null>(null);
  const [busy, setBusy] = useState<null | "open" | "approve" | "export" | "print">(null);
  const [page, setPage] = useState(0);

  const [printType, setPrintType] = useState<PrintType>("COLOR");
  const [printerId, setPrinterId] = useState<string>("");
  const [sheetCopies, setSheetCopies] = useState(1);
  const [ticket, setTicket] = useState<PrintTicketOptions>(() => ({ dpi: state.shop?.printDpi ? state.shop.printDpi : 1200 }));
  const [hard, setHard] = useState<{ hardMargins: Margins; known: boolean } | null>(null);
  const [rules, setRules] = useState<PriceRule[] | null>(null);
  const [confirmSheets, setConfirmSheets] = useState(false);
  const [round, setRound] = useState(0);
  const openedFromNav = useRef<string | null>(null);

  useEffect(() => {
    void run(window.zerox.getPricing())
      .then((r) => setRules(r.rules))
      .catch(() => setRules([]));
    void window.zerox.passport.refreshIncoming();
  }, []);

  const settings = useMemo(() => toSettings(fields), [fields]);
  // The last sensible photo shape: a half-typed or empty size doesn't move the crop.
  const lastAspect = useRef(35 / 45);
  const typedAspect = settings.photo.widthMm / settings.photo.heightMm;
  if (settings.photo.widthMm > 0 && settings.photo.heightMm > 0 && typedAspect >= 0.2 && typedAspect <= 5) lastAspect.current = typedAspect;
  const aspect = lastAspect.current;
  // The photo is rendered at the print resolution (the printer's maximum counts as 600 dpi).
  const renderDpi = ticket.dpi && ticket.dpi >= 150 && ticket.dpi <= 1200 ? ticket.dpi : 600;

  const printers = useMemo(
    () =>
      state.printers.filter(
        (p) => p.isEnabled && (settings.paperSize === "CUSTOM" || p.paperSizes.includes(settings.paperSize)) && (printType === "BW" || p.supportsColor),
      ),
    [state.printers, settings.paperSize, printType],
  );
  const printer = printers.find((p) => p.id === printerId) ?? printers.find((p) => p.id === preset?.defaultPrinterId) ?? printers[0] ?? null;

  // The printer's real margins for this paper, so the preview matches the print.
  useEffect(() => {
    if (!printer) return setHard(null);
    let cancelled = false;
    void run(window.zerox.passport.printerMargins(printer.id, settings))
      .then((h) => !cancelled && setHard(h))
      .catch(() => !cancelled && setHard(null));
    return () => {
      cancelled = true;
    };
    // Only the printer and the paper matter here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [printer?.id, settings.paperSize]);

  const layout = useMemo(() => layoutSheet(settings, hard?.hardMargins ?? null), [settings, hard]);
  useEffect(() => setPage((p) => Math.min(p, Math.max(0, layout.sheets - 1))), [layout.sheets]);

  // A new photo size keeps the same part of the photo selected (centre and zoom), in the new shape.
  const prevAspect = useRef(aspect);
  useEffect(() => {
    if (photo && crop && prevAspect.current !== aspect) setCrop(reshapeCrop(crop, photo.size, prevAspect.current, aspect));
    prevAspect.current = aspect;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aspect]);

  const sig = crop ? JSON.stringify([crop, settings.photo, renderDpi]) : "";
  const approvedNow = approved && approved.sig === sig ? approved : null;

  // On the sheet step, a change of size or resolution re-renders the approved photo from the same crop.
  useEffect(() => {
    if (step !== "sheet" || !photo || !crop || approvedNow || layout.errors.length) return;
    const t = window.setTimeout(() => void approve(false), 350);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, sig]);

  // Opened from the "new photo" popup.
  useEffect(() => {
    const id = (location.state as { incomingId?: string } | null)?.incomingId;
    if (!id || openedFromNav.current === id) return;
    openedFromNav.current = id;
    void openIncoming(id);
    navigate(location.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  function choosePreset(id: string) {
    setPresetId(id);
    const p = presets.find((x) => x.id === id);
    if (p) {
      setFields(fromPreset(p));
      if (p.defaultPrinterId) setPrinterId(p.defaultPrinterId);
    }
  }

  async function loadPhoto(l: LoadedPhoto) {
    const editable = await decodePhoto(l.dataUrl);
    photo?.bitmap.close();
    setLoaded(l);
    setPhoto(editable);
    setApproved(null);
    if (l.presetId && presets.some((p) => p.id === l.presetId)) choosePreset(l.presetId);
    const p = presets.find((x) => x.id === l.presetId);
    const a = p ? p.photoWidthMm / p.photoHeightMm : aspect;
    setCrop(initialCrop(editable.size, a));
    // Already in the new shape: nothing to reshape when the preset sets it.
    prevAspect.current = a;
    setStep("crop");
  }

  async function pick() {
    setBusy("open");
    try {
      const l = await run(window.zerox.passport.pick());
      if (l) await loadPhoto(l);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't open the photo");
    } finally {
      setBusy(null);
    }
  }

  async function openIncoming(id: string) {
    setBusy("open");
    try {
      await loadPhoto(await run(window.zerox.passport.openIncoming(id)));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't open the customer's photo");
    } finally {
      setBusy(null);
    }
  }

  async function dismissIncoming(p: IncomingPhoto) {
    try {
      await run(window.zerox.passport.finishIncoming(p.id));
      toast.success(`Photo ${p.pickupCode} removed`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't remove the photo");
    }
  }

  async function approve(go = true) {
    if (!photo || !crop) return;
    if (!(settings.photo.widthMm > 0 && settings.photo.heightMm > 0)) return void toast.error("Enter the photo width and height first");
    setBusy("approve");
    try {
      const out = outputPixelSize(settings.photo.widthMm, settings.photo.heightMm, renderDpi);
      const { jpeg, previewUrl } = await renderApproved(photo, crop, out);
      const photoId = await run(window.zerox.passport.accept(jpeg, { widthMm: settings.photo.widthMm, heightMm: settings.photo.heightMm, dpi: renderDpi }));
      setApproved({ photoId, previewUrl, sig });
      if (go) setStep("sheet");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't prepare the photo");
    } finally {
      setBusy(null);
    }
  }

  // One id per distinct print; a retry after an error reuses it, so nothing prints twice.
  const clientRef = useMemo(
    () => crypto.randomUUID(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [approvedNow?.photoId, JSON.stringify(settings), printer?.id, sheetCopies, printType, JSON.stringify(ticket), round],
  );

  const rule = rules?.find((r) => r.kind === "PHOTO_SHEET" && r.paperSize === settings.paperSize && r.printType === printType);
  const totalSheets = layout.sheets * sheetCopies;
  const colorLocked = printType === "COLOR" && !state.entitlements?.features.color;
  const canPrint = !!approvedNow && !!printer && !layout.errors.length && settings.paperSize !== "CUSTOM" && !!rule && !colorLocked && !busy;

  async function exportPdf() {
    if (!approvedNow) return;
    setBusy("export");
    try {
      const path = await run(window.zerox.passport.exportPdf(approvedNow.photoId, settings));
      if (path) toast.success("PDF saved", { description: path });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save the PDF");
    } finally {
      setBusy(null);
    }
  }

  async function print(confirmed = false) {
    if (!approvedNow || !printer) return;
    if (!confirmed && layout.sheets > 1) return setConfirmSheets(true);
    setBusy("print");
    try {
      const r = await run(
        window.zerox.passport.print({
          clientRef,
          photoId: approvedNow.photoId,
          settings,
          printerId: printer.id,
          copies: sheetCopies,
          printType,
          ticket,
          incomingId: loaded?.incomingId ?? null,
        }),
      );
      if (r.outcome === "done") toast.success(`Printed on ${printer.displayName}`, { description: `${r.sheets} sheet${r.sheets === 1 ? "" : "s"} came out. Check the photos before cutting.` });
      else toast.warning(`Sent to ${printer.displayName}`, { description: "Windows couldn't confirm it printed. Check the tray before printing again." });
      if (r.warning) toast.warning(r.warning);
      setRound((x) => x + 1);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't print");
    } finally {
      setBusy(null);
    }
  }

  if (!enabled) {
    return (
      <>
        <Header />
        <Card>
          <EmptyState
            icon={Lock}
            title="Passport photos aren't in your plan"
            description="Upgrade to crop photos and print exact-size passport photo sheets on A4 or 4 × 6 in paper."
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

  const dimLocked = !!preset && !preset.allowDimensionOverride;
  const qtyLocked = !!preset && !preset.allowQuantityOverride;
  const incoming = state.incomingPhotos;

  return (
    <div className="flex min-h-[calc(100dvh-4rem)] flex-col">
      <Header>
        {loaded && (
          <Button variant="ghost" size="sm" onClick={() => void pick()} disabled={!!busy}>
            <ImagePlus aria-hidden /> Another photo
          </Button>
        )}
      </Header>

      <div className="grid flex-1 grid-cols-[288px_1fr] gap-4">
        <Card className="space-y-4 self-start p-4">
          <Group label="Preset">
            <select
              value={presetId}
              onChange={(e) => (e.target.value === CUSTOM ? setPresetId(CUSTOM) : choosePreset(e.target.value))}
              className="h-8 w-full rounded-lg border border-input bg-card px-2 text-[13px]"
            >
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.shopId ? " · yours" : ""}
                </option>
              ))}
              <option value={CUSTOM}>Custom size</option>
            </select>
          </Group>

          <Group label="Photo size (mm)">
            <div className="grid grid-cols-2 gap-2">
              <MmField label="Width" value={fields.photoW} onChange={(v) => set("photoW", v)} disabled={dimLocked} />
              <MmField label="Height" value={fields.photoH} onChange={(v) => set("photoH", v)} disabled={dimLocked} />
            </div>
            {dimLocked && <p className="mt-1 text-caption text-muted-foreground">Fixed by this preset.</p>}
          </Group>

          <Group label="Paper">
            <Segmented
              label="Paper"
              value={fields.paper}
              onChange={(v) => set("paper", v)}
              options={[
                { value: "A4", label: "A4" },
                { value: "4X6", label: "4×6 in" },
                { value: "CUSTOM", label: "Custom" },
              ]}
            />
            {fields.paper === "CUSTOM" && (
              <div className="mt-2 grid grid-cols-2 gap-2">
                <MmField label="Width" value={fields.customW} onChange={(v) => set("customW", v)} />
                <MmField label="Height" value={fields.customH} onChange={(v) => set("customH", v)} />
              </div>
            )}
            <div className="mt-2">
              <Segmented
                label="Orientation"
                value={fields.orientation}
                onChange={(v) => set("orientation", v)}
                options={[
                  { value: "PORTRAIT", label: "Portrait" },
                  { value: "LANDSCAPE", label: "Landscape" },
                ]}
              />
            </div>
          </Group>

          <Group label="Margins (mm)">
            <div className="grid grid-cols-4 gap-1.5">
              <MmField label="Top" value={fields.mt} onChange={(v) => set("mt", v)} />
              <MmField label="Right" value={fields.mr} onChange={(v) => set("mr", v)} />
              <MmField label="Bottom" value={fields.mb} onChange={(v) => set("mb", v)} />
              <MmField label="Left" value={fields.ml} onChange={(v) => set("ml", v)} />
            </div>
          </Group>

          <Group label="Spacing (mm)">
            <div className="grid grid-cols-2 gap-2">
              <MmField label="Across" value={fields.gx} onChange={(v) => set("gx", v)} />
              <MmField label="Down" value={fields.gy} onChange={(v) => set("gy", v)} />
            </div>
          </Group>

          <Group label="Layout">
            <Segmented
              label="Layout"
              value={fields.mode}
              disabled={qtyLocked}
              onChange={(v) => set("mode", v)}
              options={[
                { value: "AUTO_FIT", label: "Fill sheet" },
                { value: "TARGET", label: "Quantity" },
              ]}
            />
            {fields.mode === "TARGET" && (
              <div className="mt-2">
                <MmField label="Photos wanted" value={fields.copies} onChange={(v) => set("copies", v.replace(/\D/g, ""))} disabled={qtyLocked} />
              </div>
            )}
            <div className="mt-2">
              <Segmented
                label="Alignment"
                value={fields.align}
                onChange={(v) => set("align", v)}
                options={[
                  { value: "CENTER", label: "Centred" },
                  { value: "TOP_LEFT", label: "Top-left" },
                ]}
              />
            </div>
          </Group>

          <Group label="Cut-out borders">
            <div className="flex items-center gap-2">
              <Segmented
                label="Borders"
                value={fields.border ? "on" : "off"}
                onChange={(v) => set("border", v === "on")}
                options={[
                  { value: "on", label: "On" },
                  { value: "off", label: "Off" },
                ]}
              />
              {fields.border && (
                <div className="w-20">
                  <MmField label="mm" value={fields.borderT} onChange={(v) => set("borderT", v)} />
                </div>
              )}
            </div>
          </Group>
        </Card>

        <div className="flex min-w-0 flex-col gap-4">
          {step === "photo" || !photo || !crop ? (
            <Card className="flex flex-1 flex-col">
              <EmptyState
                icon={SquareUser}
                title="Start with a photo"
                description="A JPEG or PNG from this computer, or one a customer sent through your photo link. The original is never changed."
                action={
                  <div className="flex gap-2">
                    <Button onClick={() => void pick()} loading={busy === "open"}>
                      <ImagePlus aria-hidden /> Choose photo
                    </Button>
                    <PhotoLinkButton />
                  </div>
                }
              />
              <IncomingList photos={incoming} busy={!!busy} onOpen={(p) => void openIncoming(p.id)} onDismiss={(p) => void dismissIncoming(p)} />
            </Card>
          ) : step === "crop" ? (
            <Card className="space-y-3 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-heading">Crop and straighten</p>
                  <p className="text-caption text-muted-foreground">
                    {loaded?.name} · locked to {fmt(settings.photo.widthMm || 0)} × {fmt(settings.photo.heightMm || 0)} mm
                  </p>
                </div>
                <Button onClick={() => void approve()} loading={busy === "approve"} disabled={!!busy}>
                  <Check aria-hidden /> Use this photo
                </Button>
              </div>
              <CropEditor photo={photo} aspect={aspect} crop={crop} onChange={setCrop} />
            </Card>
          ) : (
            <Card className="flex flex-1 flex-col gap-3 p-4">
              <div className="flex items-start justify-between gap-3">
                <Stats layout={layout} settings={settings} hard={hard} />
                <Button variant="secondary" size="sm" onClick={() => setStep("crop")} disabled={!!busy}>
                  <Pencil aria-hidden /> Edit photo
                </Button>
              </div>
              <div className="flex min-h-[320px] flex-1 items-center justify-center rounded-2xl bg-muted/60 p-4">
                {layout.errors.length ? (
                  <p className="max-w-sm text-center text-sm text-destructive">{layout.errors[0]}</p>
                ) : (
                  <SheetPreview layout={layout} page={page} photoUrl={approvedNow?.previewUrl ?? approved?.previewUrl ?? null} border={settings.border} />
                )}
              </div>
              <div className="flex items-center justify-between gap-3">
                <p className="text-caption text-muted-foreground">Screen preview, scaled to fit. Prints at exact physical size.</p>
                {layout.sheets > 1 && (
                  <div className="flex items-center gap-1.5 text-[13px]">
                    <Button size="icon-sm" variant="secondary" className="size-7" aria-label="Previous sheet" disabled={page === 0} onClick={() => setPage(page - 1)}>
                      ‹
                    </Button>
                    <span className="font-mono tabular-nums">
                      Sheet {page + 1} / {layout.sheets}
                    </span>
                    <Button size="icon-sm" variant="secondary" className="size-7" aria-label="Next sheet" disabled={page >= layout.sheets - 1} onClick={() => setPage(page + 1)}>
                      ›
                    </Button>
                  </div>
                )}
              </div>
            </Card>
          )}

          {step === "sheet" && (
            <Card className="space-y-3 p-3">
              {settings.mode === "TARGET" && !layout.errors.length && !layout.fitsOnOneSheet && (
                <p className="rounded-xl bg-warning/10 px-3 py-2 text-[13px] text-warning-foreground">
                  {layout.requested} photos won&apos;t fit on one sheet: at most {layout.perSheet} per sheet, so this makes {layout.sheets} sheets. Photos are never
                  shrunk to fit more.
                </p>
              )}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <div className="flex min-w-0 items-center gap-2 text-sm">
                  <Printer className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  {settings.paperSize === "CUSTOM" ? (
                    <span className="text-muted-foreground">Custom paper: save as PDF to print elsewhere.</span>
                  ) : printers.length === 0 ? (
                    <span className="text-destructive">
                      No turned-on printer is set up for {settings.paperSize === "4X6" ? "4 × 6 in" : "A4"}
                      {printType === "COLOR" ? " colour" : ""}. <Link to="/printers" className="underline">Check printers</Link>
                    </span>
                  ) : (
                    <select
                      value={printer?.id ?? ""}
                      disabled={!!busy}
                      onChange={(e) => setPrinterId(e.target.value)}
                      className="h-8 max-w-52 rounded-lg border border-input bg-card px-2 text-[13px]"
                    >
                      {printers.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.displayName}
                          {p.status !== "ONLINE" ? ` (${p.status.toLowerCase()})` : ""}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                <div className="w-36">
                  <Segmented
                    label="Colour"
                    value={printType}
                    disabled={!!busy}
                    onChange={setPrintType}
                    options={[
                      { value: "COLOR", label: "Colour" },
                      { value: "BW", label: "B&W" },
                    ]}
                  />
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-sm text-muted-foreground">Sets</span>
                  <Button size="icon-sm" variant="secondary" className="size-7" aria-label="Fewer sets" disabled={!!busy || sheetCopies <= 1} onClick={() => setSheetCopies((c) => c - 1)}>
                    −
                  </Button>
                  <span className="w-7 text-center font-mono tabular-nums">{sheetCopies}</span>
                  <Button size="icon-sm" variant="secondary" className="size-7" aria-label="More sets" disabled={!!busy || sheetCopies >= 20} onClick={() => setSheetCopies((c) => c + 1)}>
                    +
                  </Button>
                </div>
              </div>
              {settings.paperSize !== "CUSTOM" && (
                <PrintOptions printerId={printer?.id ?? null} value={ticket} onChange={setTicket} defaultDpi={state.shop?.printDpi ?? 600} disabled={!!busy} suggestPhotoPaper />
              )}
              <div className="grid grid-cols-2 gap-2">
                <Button loading={busy === "print"} disabled={!canPrint} onClick={() => void print()}>
                  {busy !== "print" && <Printer aria-hidden />}
                  {busy === "print"
                    ? "Printing…"
                    : `Print ${totalSheets} sheet${totalSheets === 1 ? "" : "s"}${rule ? ` · ${rupees(rule.price * totalSheets)}` : ""}`}
                </Button>
                <Button variant="secondary" loading={busy === "export"} disabled={!approvedNow || !!busy || layout.errors.length > 0} onClick={() => void exportPdf()}>
                  {busy !== "export" && <Download aria-hidden />} Save PDF
                </Button>
              </div>
              {colorLocked ? (
                <p className="px-1 text-caption text-destructive">Colour prints aren&apos;t in your plan. Choose B&amp;W.</p>
              ) : (
                rules &&
                !rule &&
                settings.paperSize !== "CUSTOM" && (
                  <p className="px-1 text-caption text-destructive">
                    Set a photo sheet price for {settings.paperSize === "4X6" ? "4 × 6 in" : "A4"} {printType === "COLOR" ? "colour" : "black & white"} in{" "}
                    <Link to="/pricing" className="underline">
                      Pricing
                    </Link>{" "}
                    first.
                  </p>
                )
              )}
            </Card>
          )}

          {step !== "photo" && incoming.length > 0 && (
            <Card className="p-0">
              <IncomingList photos={incoming} busy={!!busy} onOpen={(p) => void openIncoming(p.id)} onDismiss={(p) => void dismissIncoming(p)} />
            </Card>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmSheets}
        onOpenChange={setConfirmSheets}
        title={`Print ${totalSheets} sheets?`}
        description={`${layout.requested} photos at ${fmt(settings.photo.widthMm)} × ${fmt(settings.photo.heightMm)} mm need ${layout.sheets} sheets (${layout.perSheet} per sheet)${sheetCopies > 1 ? `, ${sheetCopies} sets` : ""}.`}
        confirmLabel={`Print ${totalSheets} sheets`}
        onConfirm={() => print(true)}
      />
    </div>
  );
}

function Header({ children }: { children?: React.ReactNode }) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <div>
        <h1 className="text-title">Passport photos</h1>
        <p className="mt-1 text-sm text-muted-foreground">Crop a photo and print exact-size copies on A4 or 4 × 6 in.</p>
      </div>
      {children}
    </div>
  );
}

function Stats({ layout, settings, hard }: { layout: ReturnType<typeof layoutSheet>; settings: PassportSheetSettings; hard: { hardMargins: Margins; known: boolean } | null }) {
  const m = layout.margins;
  const items: [string, string][] = [
    ["Paper", layout.paper.widthMm ? `${fmt(layout.paper.widthMm)} × ${fmt(layout.paper.heightMm)} mm` : "—"],
    ["Photo", `${fmt(settings.photo.widthMm || 0)} × ${fmt(settings.photo.heightMm || 0)} mm`],
    ["Grid", layout.cols ? `${layout.cols} × ${layout.rows}` : "—"],
    ["Per sheet", layout.perSheet ? String(layout.perSheet) : "—"],
    ["Photos", layout.requested ? String(layout.requested) : "—"],
    ["Sheets", layout.sheets ? String(layout.sheets) : "—"],
    ["Margins", `${fmt(m.top)}/${fmt(m.right)}/${fmt(m.bottom)}/${fmt(m.left)}`],
    ["Spacing", `${fmt(settings.gapXMm || 0)} / ${fmt(settings.gapYMm || 0)}`],
  ];
  return (
    <div>
      <dl className="grid grid-cols-4 gap-x-5 gap-y-1">
        {items.map(([k, v]) => (
          <div key={k}>
            <dt className="text-overline text-muted-foreground">{k}</dt>
            <dd className="font-mono text-[13px] tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
      {hard && !hard.known && settings.paperSize !== "CUSTOM" && (
        <p className="mt-1.5 text-caption text-warning-foreground">This printer didn&apos;t report its printable area; a 5 mm minimum margin is kept.</p>
      )}
      {hard?.known && (hard.hardMargins.top > (settings.margins.top || 0) || hard.hardMargins.left > (settings.margins.left || 0)) && (
        <p className="mt-1.5 text-caption text-muted-foreground">Margins raised to what this printer can reach.</p>
      )}
    </div>
  );
}

function IncomingList({
  photos,
  busy,
  onOpen,
  onDismiss,
}: {
  photos: IncomingPhoto[];
  busy: boolean;
  onOpen: (p: IncomingPhoto) => void;
  onDismiss: (p: IncomingPhoto) => void;
}) {
  if (photos.length === 0) return null;
  return (
    <div className="border-t px-4 py-3">
      <p className="text-overline mb-2 flex items-center gap-1.5 text-muted-foreground">
        <Inbox className="size-3.5" aria-hidden /> From customers
      </p>
      <ul className="divide-y">
        {photos.map((p) => (
          <li key={p.id} className="flex items-center gap-3 py-2">
            <span className="rounded-lg bg-lime px-2 py-0.5 font-mono text-[15px] font-bold tracking-wider text-deep">{p.pickupCode}</span>
            <span className="min-w-0 flex-1 truncate text-sm">
              {p.note ?? "No name"} <span className="text-muted-foreground">· {new Date(p.createdAt).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}</span>
            </span>
            {p.status === "OPENED" && <Badge tone="info">Opened</Badge>}
            <Button size="sm" onClick={() => onOpen(p)} disabled={busy}>
              Open
            </Button>
            <Button size="icon-sm" variant="ghost" aria-label={`Remove photo ${p.pickupCode}`} onClick={() => onDismiss(p)} disabled={busy}>
              <X aria-hidden />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PhotoLinkButton() {
  const [url, setUrl] = useState<string | null>(null);
  async function copy() {
    try {
      const link = url ?? (await run(window.zerox.passport.photoLink())).url;
      setUrl(link);
      await navigator.clipboard.writeText(link);
      toast.success("Photo link copied", { description: "Send it to the customer on WhatsApp. Their photo pops up here." });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't get the photo link");
    }
  }
  return (
    <Button variant="secondary" onClick={() => void copy()}>
      <Link2 aria-hidden /> Copy photo link
    </Button>
  );
}
