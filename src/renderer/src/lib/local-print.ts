import type { LocalPrintSettings, ServerPrinter } from "../../../shared/types";

/** Same rule as main's router.canPrint, for the printer list in "Print again". */
export function canPrintLocally(p: ServerPrinter, s: Pick<LocalPrintSettings, "printType" | "paperSize" | "duplex">): boolean {
  return (s.printType !== "COLOR" || p.supportsColor) && p.paperSizes.includes(s.paperSize) && (!s.duplex || p.supportsDuplex || p.manualDuplex);
}
