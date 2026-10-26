import { AlertTriangle, RotateCcw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import type { ConfirmDonePrompt, FlipPrompt, ManualDuplexAnswer } from "../../../shared/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { run, useAppState } from "@/lib/app-state";

const sheets = (n: number) => `${n} sheet${n === 1 ? "" : "s"}`;

/**
 * The two-sided dialog: between the passes of a manual double-sided job
 * (flip), and after the last pass of any two-sided job (confirm every page is
 * out before the job counts as printed). The operator turns the stack over
 * the same way every time (back sides are rotated in the PDF to match the
 * job's flip edge), so the flip step only shows the owner's own reload note.
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

  return (
    // Closing without choosing would leave the printer waiting, so only the buttons answer.
    <Dialog open>
      {prompt.stage === "flip" ? <Flip prompt={prompt} busy={busy} answer={answer} /> : <ConfirmDone prompt={prompt} busy={busy} answer={answer} />}
    </Dialog>
  );
}

type StepProps<P> = { prompt: P; busy: ManualDuplexAnswer | null; answer: (a: ManualDuplexAnswer) => Promise<void> };

function Flip({ prompt, busy, answer }: StepProps<FlipPrompt>) {
  const done = prompt.first === "ODD" ? "Odd" : "Even";
  const next = prompt.first === "ODD" ? "even" : "odd";
  return (
    <DialogContent
      title={prompt.specimenNo ? `${done} pages done for #${prompt.specimenNo}` : `${done} pages done`}
      description={`Now turn the stack over so ${prompt.printerName} can print the ${next} pages on the back.`}
    >
      <Uncertain show={prompt.uncertain} />
      <ol className="list-decimal space-y-2.5 pl-5 text-[15px]">
        <li>Wait until all {sheets(prompt.frontSheets)} have come out of the printer.</li>
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
        The {next} pages print next ({sheets(prompt.backSheets)}).
        {prompt.oddCount && " The back of the last sheet stays blank."}
      </p>
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <Button onClick={() => void answer("continue")} loading={busy === "continue"} disabled={!!busy}>
          Print {next} pages
        </Button>
        <Button variant="secondary" onClick={() => void answer("reprintFront")} loading={busy === "reprintFront"} disabled={!!busy}>
          <RotateCcw aria-hidden /> Print {done.toLowerCase()} pages again
        </Button>
        <Button variant="destructive" className="ml-auto" onClick={() => void answer("cancel")} loading={busy === "cancel"} disabled={!!busy}>
          Stop
        </Button>
      </div>
    </DialogContent>
  );
}

function ConfirmDone({ prompt, busy, answer }: StepProps<ConfirmDonePrompt>) {
  const job = prompt.specimenNo ? ` for #${prompt.specimenNo}` : "";
  return (
    <DialogContent
      title={`Have all pages come out${job}?`}
      description={
        prompt.byHand
          ? `Check that all ${sheets(prompt.sheets)} of back sides have come out of ${prompt.printerName}.`
          : `Check that the whole job (${sheets(prompt.sheets)}) has come out of ${prompt.printerName}, printed on both sides.`
      }
    >
      <Uncertain show={prompt.uncertain} />
      <p className="text-[15px]">The request is marked printed only when you press Done.</p>
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <Button onClick={() => void answer("done")} loading={busy === "done"} disabled={!!busy}>
          Done, all pages are out
        </Button>
        <Button variant="secondary" onClick={() => void answer("reprint")} loading={busy === "reprint"} disabled={!!busy}>
          <RotateCcw aria-hidden /> {prompt.byHand ? "Print back sides again" : "Print again"}
        </Button>
        <Button variant="destructive" className="ml-auto" onClick={() => void answer("problem")} loading={busy === "problem"} disabled={!!busy}>
          There&apos;s a problem
        </Button>
      </div>
    </DialogContent>
  );
}

function Uncertain({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <p className="mb-4 flex items-start gap-2 rounded-xl bg-muted px-3.5 py-3 text-sm">
      <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
      Zerox Buddy couldn&apos;t tell whether the printer has finished. Look at the printer before you continue.
    </p>
  );
}
