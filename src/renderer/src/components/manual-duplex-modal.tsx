import { RotateCcw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import type { ManualDuplexAnswer } from "../../../shared/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { run, useAppState } from "@/lib/app-state";

/**
 * Between the odd and even passes of a manual double-sided job. The operator
 * turns the stack over the same way every time (back sides are rotated in the
 * PDF to match the job's flip edge), so the dialog only shows the owner's own
 * reload note for this printer.
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

  return (
    // Closing without choosing would leave the printer waiting, so only the buttons answer.
    <Dialog open>
      <DialogContent
        title={prompt.specimenNo ? `Odd pages done for #${prompt.specimenNo}` : "Odd pages done"}
        description={`Now turn the stack over so ${prompt.printerName} can print the even pages on the back.`}
      >
        <ol className="list-decimal space-y-2.5 pl-5 text-[15px]">
          <li>Take the printed stack. Keep the sheets in the same order.</li>
          <li>
            Turn it over and put it back in the tray
            {prompt.note ? (
              <>
                : <span className="font-medium">{prompt.note}</span>
              </>
            ) : (
              "."
            )}
          </li>
        </ol>
        <p className="mt-4 text-sm text-muted-foreground">
          Even pages print next ({sheets(prompt.backSheets)}).
          {prompt.oddCount && " The back of the last sheet stays blank."}
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <Button onClick={() => void answer("continue")} loading={busy === "continue"} disabled={!!busy}>
            Print even pages
          </Button>
          <Button variant="secondary" onClick={() => void answer("reprintFront")} loading={busy === "reprintFront"} disabled={!!busy}>
            <RotateCcw aria-hidden /> Print odd pages again
          </Button>
          <Button variant="destructive" className="ml-auto" onClick={() => void answer("cancel")} loading={busy === "cancel"} disabled={!!busy}>
            Stop
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
