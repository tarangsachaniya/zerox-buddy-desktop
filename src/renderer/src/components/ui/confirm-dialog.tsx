"use client";

import { useState } from "react";

import { Button } from "./button";
import { Dialog, DialogContent } from "./dialog";

/**
 * The app's own confirmation modal, for anywhere that used to call the
 * browser's window.confirm(). Fully controlled and headless: it has no
 * trigger of its own, so an existing button just flips `open` on click —
 * see app/(dashboard)/dashboard/qr/page.tsx's RegenerateDialog for the same
 * Dialog/DialogContent shape this generalizes.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => Promise<void> | void;
}) {
  const [pending, setPending] = useState(false);

  async function confirm() {
    setPending(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={title} description={description}>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button
            className={destructive ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : undefined}
            loading={pending}
            onClick={confirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
