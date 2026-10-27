import { Check, Download, FileText, ImagePlus, Inbox, Link2, Lock, Pencil, SquareUser, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { initialCrop, outputPixelSize, reshapeCrop, type PhotoCrop } from "../../../shared/passport/crop";
import type { PassportPaperCode } from "../../../shared/passport/paper";
import { layoutSheet, type PassportSheetSettings } from "../../../shared/passport/sheet";
import type { IncomingPhoto, LoadedPhoto, PassportPreset } from "../../../shared/types";
import { CropEditor } from "@/components/passport/crop-editor";
import { SheetPreview } from "@/components/passport/sheet-preview";
import { Button } from "@/components/ui/button";
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
  borderP: string;
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
  borderP: "0",
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
    borderP: String(p.borderPaddingMm ?? 0),
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
    border: { enabled: f.border, thicknessMm: n(f.borderT), paddingMm: f.borderP.trim() === "" ? 0 : n(f.borderP) },
  };
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

type Remembered = { presetId: string; fields: Fields };

const REMEMBER_KEY = "zerox.passport.last";

/** Last time's choices, if they still make sense (the preset may since have been removed). */
function recall(presets: PassportPreset[]): Remembered | null {
  try {
    const r = JSON.parse(localStorage.getItem(REMEMBER_KEY) ?? "null") as Remembered | null;
    if (!r || typeof r !== "object" || !r.fields) return null;
    if (r.presetId !== CUSTOM && !presets.some((p) => p.id === r.presetId)) return null;
    return { ...r, fields: { ...DEFAULT_FIELDS, ...r.fields } };
  } catch {
    return null;
  }
}

function remember(r: Remembered): void {
  try {
    localStorage.setItem(REMEMBER_KEY, JSON.stringify(r));
  } catch {
    // Storage off: the choices just aren't kept.
  }
}

export function PassportScreen() {
  const state = useAppState()!;
  const location = useLocation();
  const navigate = useNavigate();
  const enabled = !!state.entitlements?.features.passport_photo;
  const presets = state.passportPresets;

  // Last time's preset and sizes on this computer, so it's choose photo → Save & open.
  const [remembered] = useState(() => recall(presets));
  const [presetId, setPresetId] = useState<string>(() => remembered?.presetId ?? presets[0]?.id ?? CUSTOM);
  const preset = presets.find((p) => p.id === presetId) ?? null;
  const [fields, setFields] = useState<Fields>(() => remembered?.fields ?? (presets[0] ? fromPreset(presets[0]) : DEFAULT_FIELDS));
  const set = <K extends keyof Fields>(key: K, value: Fields[K]) => setFields((f) => ({ ...f, [key]: value }));

  const [loaded, setLoaded] = useState<LoadedPhoto | null>(null);
  const [photo, setPhoto] = useState<EditablePhoto | null>(null);
  const [crop, setCrop] = useState<PhotoCrop | null>(null);
  const [step, setStep] = useState<"photo" | "crop" | "sheet">("photo");
  const [approved, setApproved] = useState<Approved | null>(null);
  const [busy, setBusy] = useState<null | "open" | "approve" | "export">(null);
  const [page, setPage] = useState(0);

  const openedFromNav = useRef<string | null>(null);

  useEffect(() => {
    remember({ presetId, fields });
  }, [presetId, fields]);

  useEffect(() => {
    void window.zerox.passport.refreshIncoming();
  }, []);

  const settings = useMemo(() => toSettings(fields), [fields]);
  // The last sensible photo shape: a half-typed or empty size doesn't move the crop.
  const lastAspect = useRef(35 / 45);
  const typedAspect = settings.photo.widthMm / settings.photo.heightMm;
  if (settings.photo.widthMm > 0 && settings.photo.heightMm > 0 && typedAspect >= 0.2 && typedAspect <= 5) lastAspect.current = typedAspect;
  const aspect = lastAspect.current;
  // The photo goes into the PDF at 1200 dpi; the viewer's printer settings decide how it prints.
  const renderDpi = 1200;

  // No printer here: the PDF is the paper as laid out, centred; the viewer prints it.
  const layout = useMemo(() => layoutSheet(settings), [settings]);
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
    if (p) setFields(fromPreset(p));
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

  async function saveAndOpen(ask: boolean) {
    if (!approvedNow) return;
    setBusy("export");
    try {
      const path = await run(window.zerox.passport.exportPdf(approvedNow.photoId, settings, { ask }));
      if (!path) return;
      toast.success("Opened in your PDF viewer", { description: "Press Ctrl+P and choose Actual size (100%), not Fit." });
      // A customer's photo is done once its sheet is saved.
      if (loaded?.incomingId) void run(window.zerox.passport.finishIncoming(loaded.incomingId)).catch(() => {});
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save the PDF");
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
                <>
                  <div className="w-16">
                    <MmField label="Line mm" value={fields.borderT} onChange={(v) => set("borderT", v)} />
                  </div>
                  <div className="w-16">
                    <MmField label="Gap mm" value={fields.borderP} onChange={(v) => set("borderP", v)} />
                  </div>
                </>
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
                <Stats layout={layout} settings={settings} />
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
            <Card className="space-y-2.5 p-3">
              {settings.mode === "TARGET" && !layout.errors.length && !layout.fitsOnOneSheet && (
                <p className="rounded-xl bg-warning/10 px-3 py-2 text-[13px] text-warning-foreground">
                  {layout.requested} photos won&apos;t fit on one sheet: at most {layout.perSheet} per sheet, so the PDF has {layout.sheets} pages. Photos are never
                  shrunk to fit more.
                </p>
              )}
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <Button loading={busy === "export"} disabled={!approvedNow || !!busy || layout.errors.length > 0} onClick={() => void saveAndOpen(false)}>
                  {busy !== "export" && <FileText aria-hidden />} Save &amp; open PDF
                </Button>
                <Button variant="secondary" disabled={!approvedNow || !!busy || layout.errors.length > 0} onClick={() => void saveAndOpen(true)}>
                  <Download aria-hidden /> Save as…
                </Button>
              </div>
              <p className="px-1 text-caption text-muted-foreground">
                Opens in your PDF viewer. Press <b>Ctrl+P</b>, choose the paper ({settings.paperSize === "4X6" ? "4 × 6 in" : settings.paperSize === "A4" ? "A4" : "custom size"}) and
                set Scale to <b>Actual size / 100%</b>, not Fit, so photos print at exactly {fmt(settings.photo.widthMm || 0)} × {fmt(settings.photo.heightMm || 0)} mm.
              </p>
            </Card>
          )}

          {step !== "photo" && incoming.length > 0 && (
            <Card className="p-0">
              <IncomingList photos={incoming} busy={!!busy} onOpen={(p) => void openIncoming(p.id)} onDismiss={(p) => void dismissIncoming(p)} />
            </Card>
          )}
        </div>
      </div>

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

function Stats({ layout, settings }: { layout: ReturnType<typeof layoutSheet>; settings: PassportSheetSettings }) {
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
