import { ImagePlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import type { IncomingPhoto } from "../../../shared/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useAppState } from "@/lib/app-state";

/**
 * When a customer sends a photo through the shop's photo link, it pops up
 * here — on any screen — with their code, ready to open in Passport photos.
 * Each photo pops up once; "Later" leaves it in the list on that screen.
 */
export function IncomingPhotoPopup() {
  const state = useAppState()!;
  const navigate = useNavigate();
  const location = useLocation();
  const seen = useRef<Set<string> | null>(null);
  const [current, setCurrent] = useState<IncomingPhoto | null>(null);

  useEffect(() => {
    const photos = state.incomingPhotos;
    // Photos already waiting when the window opened don't pop up; they're listed on the screen.
    if (seen.current === null) {
      seen.current = new Set(photos.map((p) => p.id));
      return;
    }
    const fresh = photos.find((p) => p.status === "READY" && !seen.current!.has(p.id));
    for (const p of photos) seen.current.add(p.id);
    if (fresh && !current) setCurrent(fresh);
  }, [state.incomingPhotos, current]);

  // Gone (opened elsewhere, removed, expired): close.
  useEffect(() => {
    if (current && !state.incomingPhotos.some((p) => p.id === current.id)) setCurrent(null);
  }, [state.incomingPhotos, current]);

  if (!current) return null;

  function open() {
    if (!current) return;
    const incomingId = current.id;
    setCurrent(null);
    navigate("/passport", { state: { incomingId }, replace: location.pathname === "/passport" });
  }

  return (
    <Dialog open onOpenChange={(next) => !next && setCurrent(null)}>
      <DialogContent title="New photo from a customer" description="Sent through your photo link for passport photos.">
        <div className="mt-5 flex items-center gap-4 rounded-2xl bg-muted px-4 py-3">
          <span className="rounded-xl bg-lime px-3 py-1 font-mono text-[28px] font-bold tracking-[0.12em] text-deep">{current.pickupCode}</span>
          <div className="min-w-0">
            <p className="truncate text-[15px] font-medium">{current.note ?? "No name given"}</p>
            <p className="text-caption text-muted-foreground">
              {new Date(current.createdAt).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })} · ask for this code at the counter
            </p>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setCurrent(null)}>
            Later
          </Button>
          <Button onClick={open}>
            <ImagePlus aria-hidden /> Open in Passport photos
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
