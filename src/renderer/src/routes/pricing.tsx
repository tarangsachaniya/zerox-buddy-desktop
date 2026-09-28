import { IndianRupee, Lock, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import type { PaperSizeCatalogEntry, PriceKind, PrintType } from "../../../shared/types";
import { Button } from "@/components/ui/button";
import { Card, EmptyState } from "@/components/ui/primitives";
import { run, useAppState } from "@/lib/app-state";

/**
 * The shop's rate card, ported from priinteve-zerox's
 * app/(dashboard)/dashboard/pricing/page.tsx (same row generation and
 * draft/changed/Discard/Save shape) so a missing price — like the 80mm
 * thermal roll never showing up for customers — can be fixed without
 * leaving the desktop app for the web dashboard.
 */

const PRINT_TYPE_LABEL: Record<PrintType, string> = { BW: "Black & White", COLOR: "Color" };
const PRICE_RE = /^\d{1,5}(\.\d{1,2})?$/;

type Rule = { kind: PriceKind; paperSize: string; printType: PrintType; price: number };
type Row = { kind: PriceKind; paperSize: string; printType: PrintType; label: string; unit: string };

/** One PAGE row per BW/COLOR, plus one PHOTO_SHEET/COLOR row, for every active catalog size. */
function rowsFor(catalog: PaperSizeCatalogEntry[]): Row[] {
  return catalog.flatMap((size) => [
    { kind: "PAGE" as const, paperSize: size.code, printType: "BW" as const, label: `${size.label} · Black & White`, unit: "per page" },
    { kind: "PAGE" as const, paperSize: size.code, printType: "COLOR" as const, label: `${size.label} · Color`, unit: "per page" },
    {
      kind: "PHOTO_SHEET" as const,
      paperSize: size.code,
      printType: "COLOR" as const,
      label: `Passport photos · ${size.label} sheet`,
      unit: "per sheet",
    },
  ]);
}

const keyOf = (r: { kind: string; paperSize: string; printType: string }) => `${r.kind}:${r.paperSize}:${r.printType}`;

export function PricingScreen() {
  const state = useAppState()!;
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoadError(null);
    try {
      const { rules: fresh } = await run(window.zerox.getPricing());
      setRules(fresh);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Couldn't load your prices");
    }
  }

  useEffect(() => {
    void load();
    // Reload whenever the paper-size catalog changes, so a size added on the
    // web admin side while this screen is open still gets a price row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saved = useMemo(() => {
    const map: Record<string, string> = {};
    for (const r of rules ?? []) map[keyOf(r)] = String(r.price);
    return map;
  }, [rules]);

  useEffect(() => setDraft(saved), [saved]);

  const paperSizeCatalog = state.paperSizeCatalog;
  const ROWS = useMemo(() => rowsFor(paperSizeCatalog), [paperSizeCatalog]);
  const a3GatedCodes = useMemo(
    () => new Set(paperSizeCatalog.filter((s) => s.requiresA3Feature).map((s) => s.code)),
    [paperSizeCatalog],
  );
  const features = state.entitlements?.features ?? null;
  const locked = (row: Row) =>
    !!features &&
    ((row.printType === "COLOR" && !features.color && row.kind === "PAGE") ||
      (a3GatedCodes.has(row.paperSize) && !features.a3) ||
      (row.kind === "PHOTO_SHEET" && !features.passport_photo));

  const changed = ROWS.filter((r) => draft[keyOf(r)] !== undefined && draft[keyOf(r)] !== saved[keyOf(r)]);
  const invalid = changed.some((r) => {
    const v = draft[keyOf(r)];
    return v === "" || !PRICE_RE.test(v ?? "");
  });

  async function save() {
    setSaving(true);
    try {
      const { rules: fresh } = await run(
        window.zerox.updatePricing(
          changed.map((r) => ({ kind: r.kind, paperSize: r.paperSize, printType: r.printType, price: Number(draft[keyOf(r)]) })),
        ),
      );
      setRules(fresh);
      toast.success("Prices saved", { description: "New print requests use these prices right away." });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save this");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-title">Pricing</h1>
          <p className="mt-1 text-[15px] text-muted-foreground">
            Your own rate card. Customers see an estimate from these prices, and every order is charged by them.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {changed.length > 0 && (
            <Button variant="ghost" onClick={() => setDraft(saved)}>
              Discard
            </Button>
          )}
          <Button onClick={save} loading={saving} disabled={changed.length === 0 || invalid || !rules}>
            Save changes
          </Button>
        </div>
      </div>

      <Card className="overflow-hidden">
        {loadError && !rules ? (
          <EmptyState icon={RefreshCw} title="Couldn't load your prices" description={loadError} action={<Button onClick={load}>Try again</Button>} />
        ) : paperSizeCatalog.length === 0 ? (
          <EmptyState icon={IndianRupee} title="No paper sizes yet" description="Paper sizes are set up by Priinteve — check back once your catalog is ready." />
        ) : (
          <ul className="divide-y">
            {ROWS.map((row) => {
              const k = keyOf(row);
              const isLocked = locked(row);
              const value = draft[k] ?? "";
              const bad = value !== "" && !PRICE_RE.test(value);
              return (
                <li key={k} className="flex items-center gap-4 px-6 py-4">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{row.label}</p>
                    <p className="text-caption font-normal text-muted-foreground">
                      {isLocked ? (
                        <span className="inline-flex items-center gap-1">
                          <Lock className="size-3" aria-hidden /> Included with Prime
                        </span>
                      ) : (
                        `${PRINT_TYPE_LABEL[row.printType]} ${row.unit}`
                      )}
                    </p>
                  </div>
                  {!rules ? (
                    <div className="h-10 w-28 animate-pulse rounded-xl bg-muted" />
                  ) : (
                    <label className="relative w-32">
                      <span className="sr-only">{row.label} price in rupees</span>
                      <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">₹</span>
                      <input
                        inputMode="decimal"
                        value={value}
                        onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value.trim() }))}
                        aria-invalid={bad || undefined}
                        className="h-10 w-full rounded-xl border border-input bg-card pl-7 pr-3 text-right text-[15px] tabular-nums outline-none transition-[border-color,box-shadow] focus-visible:border-ring focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/15 aria-[invalid=true]:border-destructive"
                      />
                    </label>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <p className="mt-4 text-caption font-normal text-muted-foreground">
        Double-sided prints are charged per printed side. Locked prices are kept and start applying as soon as your plan includes them.
      </p>
    </>
  );
}
