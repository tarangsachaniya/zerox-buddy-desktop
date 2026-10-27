import { Settings2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import type { PrintCapabilities, PrintTicketOptions } from "../../../shared/types";
import { Button } from "@/components/ui/button";
import { run } from "@/lib/app-state";

/**
 * What Ctrl+P → Preferences would set, for one counter print: paper type,
 * print quality and resolution, from what this printer's driver offers. Unset
 * keeps the printer's own setting; the DPI starts at the shop's print DPI
 * (Settings). "Printer preferences…" opens the driver's own dialog for
 * anything else (borderless, colour tweaks).
 */

const SELECT = "h-8 w-full rounded-lg border border-input bg-card px-2 text-[13px] disabled:opacity-50";

export function PrintOptions({
  printerId,
  value,
  onChange,
  defaultDpi,
  disabled,
  suggestPhotoPaper,
}: {
  printerId: string | null;
  value: PrintTicketOptions;
  onChange: (next: PrintTicketOptions) => void;
  /** The shop's print DPI (0 = printer maximum). */
  defaultDpi: number;
  disabled?: boolean;
  /** Passport photos: pick glossy photo paper when the driver has it. */
  suggestPhotoPaper?: boolean;
}) {
  const [caps, setCaps] = useState<PrintCapabilities | null | "loading">("loading");

  useEffect(() => {
    if (!printerId) return setCaps(null);
    let cancelled = false;
    setCaps("loading");
    void run(window.zerox.printOptions.get(printerId))
      .then((c) => {
        if (cancelled) return;
        setCaps(c);
        if (suggestPhotoPaper && c && !value.mediaType) {
          const photo = c.mediaTypes.find((m) => m.value === "PhotographicGlossy") ?? c.mediaTypes.find((m) => m.value.startsWith("Photographic"));
          if (photo) onChange({ ...value, mediaType: photo.value });
        }
      })
      .catch(() => !cancelled && setCaps(null));
    return () => {
      cancelled = true;
    };
    // Only when the printer changes; the suggestion must not override the operator later.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [printerId]);

  async function preferences() {
    if (!printerId) return;
    try {
      await run(window.zerox.printOptions.preferences(printerId));
      const fresh = await run(window.zerox.printOptions.get(printerId, true));
      setCaps(fresh);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't open the printer's preferences");
    }
  }

  const loaded = caps !== "loading" && caps !== null ? caps : null;
  const dpiValue = value.dpi ?? defaultDpi;
  const dpiChoices = [...new Set([...(loaded?.resolutions.map((r) => r.x) ?? [300, 600, 1200]), ...(defaultDpi > 0 ? [defaultDpi] : [])])].sort((a, b) => a - b);

  return (
    <div className="grid gap-2">
      <div className="grid grid-cols-3 gap-2">
        <label className="grid gap-1">
          <span className="text-overline text-muted-foreground">Paper type</span>
          <select
            className={SELECT}
            disabled={disabled || !loaded || loaded.mediaTypes.length === 0}
            value={value.mediaType ?? ""}
            onChange={(e) => onChange({ ...value, mediaType: e.target.value || null })}
          >
            <option value="">{caps === "loading" ? "Checking…" : "Printer's setting"}</option>
            {loaded?.mediaTypes.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          <span className="text-overline text-muted-foreground">Quality</span>
          <select
            className={SELECT}
            disabled={disabled || !loaded || loaded.qualities.length === 0}
            value={value.quality ?? ""}
            onChange={(e) => onChange({ ...value, quality: e.target.value || null })}
          >
            <option value="">{caps === "loading" ? "Checking…" : "Printer's setting"}</option>
            {loaded?.qualities.map((q) => (
              <option key={q.value} value={q.value}>
                {q.label}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          <span className="text-overline text-muted-foreground">Resolution</span>
          <select className={SELECT} disabled={disabled} value={String(dpiValue)} onChange={(e) => onChange({ ...value, dpi: Number(e.target.value) })}>
            <option value="0">Printer maximum</option>
            {dpiChoices.map((d) => (
              <option key={d} value={d}>
                {d} dpi
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-caption text-muted-foreground">
          {caps === null && printerId ? "Windows didn't list this printer's options; it prints with its own settings." : "Applied for this print only, then put back."}
        </p>
        <Button size="sm" variant="ghost" disabled={disabled || !printerId} onClick={() => void preferences()}>
          <Settings2 aria-hidden /> Printer preferences…
        </Button>
      </div>
    </div>
  );
}
