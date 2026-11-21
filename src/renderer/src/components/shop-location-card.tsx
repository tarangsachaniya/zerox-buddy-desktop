import { LocateFixed, MapPin } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import type { ShopInfo } from "../../../shared/types";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Card, CardHeader } from "@/components/ui/primitives";
import { run } from "@/lib/app-state";

type Point = { latitude: number; longitude: number };

/** A reading rougher than this is likely an IP/Wi-Fi guess, not the shop. */
const ROUGH_ACCURACY_METERS = 200;

/**
 * "21.1702, 72.8311", or a Google Maps link containing "@21.17,72.83" or
 * "?q=21.17,72.83". Same as priinteve-zerox's shop-location-card.
 */
export function parseCoordinates(text: string): Point | null {
  const m = text.match(/(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)/);
  if (!m) return null;
  const latitude = Number(m[1]);
  const longitude = Number(m[2]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  if (latitude === 0 && longitude === 0) return null;
  return { latitude, longitude };
}

function mapEmbedUrl({ latitude, longitude }: Point): string {
  const dLat = 0.002;
  const dLng = 0.003;
  const bbox = [longitude - dLng, latitude - dLat, longitude + dLng, latitude + dLat].map((n) => n.toFixed(6)).join(",");
  return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${latitude.toFixed(6)},${longitude.toFixed(6)}`;
}

function savedPoint(shop: ShopInfo): Point | null {
  return shop.latitude != null && shop.longitude != null ? { latitude: shop.latitude, longitude: shop.longitude } : null;
}

const READ_FAILED: Record<"denied" | "off" | "unavailable", string> = {
  denied: "Windows is blocking location for apps. Turn it on in Windows Settings → Privacy & security → Location, or paste the location from Google Maps below.",
  off: "Location is off on this computer. Turn it on in Windows Settings → Privacy & security → Location, or paste the location from Google Maps below.",
  unavailable: "Couldn't find this computer's location. Paste your shop's location from Google Maps below.",
};

/**
 * Where the shop is. Customers can then only send prints and passport photos
 * from phones within `geofenceMeters` of it, so a photo of the QR can't be used
 * from home. Required before the shop can open (LocationSetupScreen); also in
 * Settings to move it. Clearing it stays on the web dashboard.
 */
export function ShopLocationCard({ shop, required = false }: { shop: ShopInfo; required?: boolean }) {
  const saved = savedPoint(shop);
  const meters = shop.geofenceMeters ?? 150;
  const [draft, setDraft] = useState<Point | null>(saved);
  const [typed, setTyped] = useState("");
  const [locating, setLocating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  useEffect(() => setDraft(savedPoint(shop)), [shop.latitude, shop.longitude]); // eslint-disable-line react-hooks/exhaustive-deps

  const changed = draft?.latitude !== saved?.latitude || draft?.longitude !== saved?.longitude;

  async function useComputerLocation() {
    setLocating(true);
    setHint(null);
    try {
      const result = await run(window.zerox.readLocation());
      if (!result.ok) {
        setHint(READ_FAILED[result.reason]);
        return;
      }
      setDraft({ latitude: result.lat, longitude: result.lng });
      if (result.accuracy === null || result.accuracy > ROUGH_ACCURACY_METERS) {
        setHint(
          `This is a rough location${result.accuracy ? ` (about ±${result.accuracy} m)` : ""}. Check the pin is on your shop; if not, paste the exact location from Google Maps below.`,
        );
      } else {
        setHint("Check the pin is on your shop, then save.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't read the location");
    } finally {
      setLocating(false);
    }
  }

  function applyTyped() {
    const point = parseCoordinates(typed);
    if (!point) {
      toast.error("Paste coordinates like 21.1702, 72.8311 or a Google Maps link.");
      return;
    }
    setDraft(point);
    setHint("Check the pin is on your shop, then save.");
  }

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      await run(window.zerox.setShopLocation(draft));
      toast.success("Shop location saved", { description: `Customers can now send prints from within about ${meters} m of your shop.` });
      setHint(null);
      setTyped("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save the location");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Shop location"
        description={`Customers can only send prints from within about ${meters} m of your shop, so nobody can print from home with a photo of your QR.`}
      />
      <div className="grid gap-5 p-6">
        {draft ? (
          <div className="overflow-hidden rounded-2xl border">
            <iframe title="Shop location on the map" src={mapEmbedUrl(draft)} className="h-56 w-full border-0" loading="lazy" referrerPolicy="no-referrer" />
            <p className="border-t px-4 py-2 font-mono text-[12px] text-muted-foreground">
              {draft.latitude.toFixed(6)}, {draft.longitude.toFixed(6)}
            </p>
          </div>
        ) : (
          <div className="flex items-start gap-3 rounded-2xl bg-warning/10 px-4 py-3 text-sm text-warning-foreground">
            <MapPin className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p>{required ? "Not set yet. Zerox Buddy can start taking prints once it's set." : "Not set yet."}</p>
          </div>
        )}

        {hint && <p className="rounded-xl bg-muted px-4 py-3 text-sm text-muted-foreground">{hint}</p>}

        <div>
          <Button onClick={useComputerLocation} loading={locating}>
            {!locating && <LocateFixed aria-hidden />} Use this computer&apos;s location
          </Button>
        </div>

        <Field
          label="Or paste from Google Maps"
          htmlFor="shop-coords"
          hint="In Google Maps, right-click (or press and hold) on your shop and copy the numbers, like 21.1702, 72.8311. A Google Maps link works too."
        >
          <div className="flex gap-2">
            <Input
              id="shop-coords"
              value={typed}
              placeholder="21.1702, 72.8311"
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && applyTyped()}
            />
            <Button variant="secondary" onClick={applyTyped} disabled={!typed.trim()}>
              Show
            </Button>
          </div>
        </Field>

        <div className="flex justify-end gap-2">
          {changed && saved && (
            <Button variant="ghost" onClick={() => setDraft(saved)}>
              Discard
            </Button>
          )}
          <Button variant={required ? "lime" : "primary"} onClick={() => void save()} loading={saving} disabled={!draft || !changed}>
            Save location
          </Button>
        </div>
      </div>
    </Card>
  );
}
