import { RotateCcw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import type { ManualDuplexAnswer } from "../../../shared/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { run, useAppState } from "@/lib/app-state";

/**
 * Between the front and back passes of a manual double-sided job. The printer
 * has no duplex unit, so the operator turns the stack over. The way to turn it
 * and how to reload it depend on the printer, so the dialog says what the job
 * needs (which edge to flip on) and shows the owner's own reload note for this
 * printer instead of guessing a direction.
 */
export function ManualDuplexModal() {
  const prompt = useAppState()?.manualDuplexPrompt;
  const [busy, setBusy] = useState<ManualDuplexAnswer | null>(null);
  if (!prompt) return null;

  async function answer(a: ManualDuplexAnswer) {
    setBusy(a);
    try {
      await run(window.zerox.answerManualDuplex(a));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't send that");
    } finally {
      setBusy(null);
    }
  }

  const sheets = (n: number) => `${n} sheet${n === 1 ? "" : "s"}`;
  const flipText =
    prompt.flip === "LONG"
      ? "Turn the stack over like the page of a book, flipping on the long edge."
      : "Turn the stack over like a notepad, flipping the top edge over to the bottom.";

  return (
    // Closing without choosing would leave the printer waiting, so only the buttons answer.
    <Dialog open>
      <DialogContent
        title={prompt.specimenNo ? `Flip the paper for #${prompt.specimenNo}` : "Flip the paper"}
        description={`Front sides are printed on ${prompt.printerName} (${sheets(prompt.frontSheets)}).`}
      >
        <ol className="list-decimal space-y-2.5 pl-5 text-[15px]">
          <li>Take the printed stack from the output tray. Keep the sheets in the same order.</li>
          <li>{flipText}</li>
          <li>
            {prompt.note ? (
              <>
                Put it back in the tray: <span className="font-medium">{prompt.note}</span>
              </>
            ) : (
              "Put it back in the tray the way this printer feeds paper. Not sure which way? Cancel, then use Test double-sided on the Printers page."
            )}
          </li>
        </ol>
        <p className="mt-4 text-sm text-muted-foreground">
          {sheets(prompt.backSheets)} will print next
          {prompt.evenOrder === "REVERSE" ? ", last page first" : ""}.
          {prompt.oddCount && " This request has an odd number of pages, so the back of the last sheet stays blank."}
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <Button onClick={() => void answer("continue")} loading={busy === "continue"} disabled={!!busy}>
            Print back sides
          </Button>
          <Button variant="secondary" onClick={() => void answer("reprintFront")} loading={busy === "reprintFront"} disabled={!!busy}>
            <RotateCcw aria-hidden /> Print fronts again
          </Button>
          <Button variant="destructive" className="ml-auto" onClick={() => void answer("cancel")} loading={busy === "cancel"} disabled={!!busy}>
            Stop
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
