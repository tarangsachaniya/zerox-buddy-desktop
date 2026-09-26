import { CreditCard, FolderOpen, LogOut, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import type { ShopInfo } from "../../../shared/types";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/field";
import { Card, CardHeader } from "@/components/ui/primitives";
import { SwitchRow } from "@/components/ui/switch";
import { run, useAppState } from "@/lib/app-state";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

type PrintDraft = Pick<ShopInfo, "autoPrint" | "autoRouting" | "requirePreview" | "autoDeleteFiles"> & { defaultCopies: string };

const printOf = (s: ShopInfo): PrintDraft => ({
  autoPrint: s.autoPrint,
  autoRouting: s.autoRouting,
  requirePreview: s.requirePreview,
  autoDeleteFiles: s.autoDeleteFiles,
  defaultCopies: String(s.defaultCopies),
});

function same<T extends object>(a: T, b: T): boolean {
  return (Object.keys(a) as (keyof T)[]).every((k) => a[k] === b[k]);
}

/**
 * Editable in-app — ported from priinteve-zerox's
 * app/(dashboard)/dashboard/settings/page.tsx PrintSettings component (same
 * draft/changed/Discard/Save shape), so the desktop no longer has to send
 * the counter to a browser tab just to flip a switch.
 */
function PrintSettingsCard({ shop }: { shop: ShopInfo }) {
  const [draft, setDraft] = useState(printOf(shop));
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(printOf(shop)), [shop]);

  const changed = !same(draft, printOf(shop));
  const copiesOk = /^\d{1,2}$/.test(draft.defaultCopies) && Number(draft.defaultCopies) >= 1;

  async function save() {
    setSaving(true);
    try {
      await run(
        window.zerox.updatePrintSettings({
          autoPrint: draft.autoPrint,
          autoRouting: draft.autoRouting,
          requirePreview: draft.requirePreview,
          autoDeleteFiles: draft.autoDeleteFiles,
          defaultCopies: Number(draft.defaultCopies),
        }),
      );
      toast.success("Print settings saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save this");
    } finally {
      setSaving(false);
    }
  }

  const set = (key: keyof Omit<PrintDraft, "defaultCopies">) => (next: boolean) => setDraft({ ...draft, [key]: next });

  return (
    <Card>
      <CardHeader title="Printing" description="How this shop handles new print requests." />
      <div className="divide-y divide-border px-6">
        <SwitchRow
          id="st-autoprint"
          title="Print automatically"
          description="New requests print as soon as they arrive. Turn off to press Print for each one."
          checked={draft.autoPrint}
          onChange={set("autoPrint")}
        />
        <SwitchRow
          id="st-routing"
          title="Choose the printer automatically"
          description="Sends each job to a printer that supports it (color, A3, double-sided) and is free."
          checked={draft.autoRouting}
          onChange={set("autoRouting")}
        />
        <SwitchRow
          id="st-preview"
          title="Preview before printing"
          description="Open each document on this computer and confirm before it prints."
          checked={draft.requirePreview}
          onChange={set("requirePreview")}
        />
        <SwitchRow
          id="st-delete"
          title="Delete files after printing"
          description="Customer files are removed as soon as the job is done. Recommended for privacy."
          checked={draft.autoDeleteFiles}
          onChange={set("autoDeleteFiles")}
        />
        <div className="flex items-center justify-between gap-6 py-4">
          <div>
            <label htmlFor="st-copies" className="text-[15px] font-medium text-foreground">
              Default copies
            </label>
            <p className="mt-0.5 text-sm text-muted-foreground">Pre-selected on the customer upload page.</p>
          </div>
          <Input
            id="st-copies"
            inputMode="numeric"
            className="w-20 text-center tabular-nums"
            value={draft.defaultCopies}
            aria-invalid={!copiesOk}
            onChange={(e) => setDraft({ ...draft, defaultCopies: e.target.value.replace(/\D/g, "").slice(0, 2) })}
          />
        </div>
      </div>
      <div className="flex justify-end gap-2 border-t px-6 py-4">
        {changed && (
          <Button variant="ghost" onClick={() => setDraft(printOf(shop))}>
            Discard
          </Button>
        )}
        <Button onClick={save} loading={saving} disabled={!changed || !copiesOk}>
          Save print settings
        </Button>
      </div>
    </Card>
  );
}

function UpdateCheckButton() {
  const [checking, setChecking] = useState(false);

  async function check() {
    setChecking(true);
    try {
      const result = await run(window.zerox.updater.check());
      // Available/required updates announce themselves through the updater overlay.
      if (result.status === "no-update") toast.success(`You're on the latest version (v${result.currentVersion})`);
      else if (result.status === "check-failed") toast.error("Couldn't check for updates. Check the internet connection.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't check for updates");
    } finally {
      setChecking(false);
    }
  }

  return (
    <Button variant="secondary" size="sm" onClick={check} loading={checking}>
      {!checking && <RefreshCw aria-hidden />} Check for updates
    </Button>
  );
}

export function SettingsScreen() {
  const state = useAppState()!;
  const shop = state.shop;
  const [signingOut, setSigningOut] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    await window.zerox.logout();
  }

  return (
    <>
      <h1 className="text-title">Settings</h1>
      <p className="mt-1 text-[15px] text-muted-foreground">This computer, and how your shop prints.</p>

      <div className="mt-6 grid gap-6">
        <Card>
          <CardHeader
            title="This computer"
            description="Zerox Buddy keeps printing from the tray when you close this window."
          />
          <div className="px-6 pb-2">
            <SwitchRow
              id="start-with-windows"
              title="Start with Windows"
              description="Opens in the tray when the computer starts, so printing never waits for someone to open it."
              checked={state.startWithWindows}
              onChange={async (next) => {
                try {
                  await run(window.zerox.setStartWithWindows(next));
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : "Couldn't change this");
                }
              }}
            />
          </div>
        </Card>

        {shop && <PrintSettingsCard shop={shop} />}

        <Card>
          <CardHeader title="Account" />
          <div className="divide-y px-6 pb-2">
            <Row label="Shop" value={shop ? `${shop.shopName} · ${shop.shopCode}` : "…"} />
            <Row
              label="Plan"
              value={state.entitlements ? state.entitlements.planName + (state.entitlements.trialEndsAt ? " (trial)" : "") : "…"}
            />
          </div>
          <div className="flex items-center justify-between px-6 pb-5 pt-2">
            <Link to="/subscription" className="flex items-center gap-1.5 text-sm font-medium text-foreground underline decoration-lime decoration-2 underline-offset-4">
              <CreditCard className="size-4" aria-hidden /> View plan & usage
            </Link>
            <Button variant="secondary" loading={signingOut} onClick={() => setConfirmSignOut(true)}>
              {!signingOut && <LogOut aria-hidden />} Sign out
            </Button>
          </div>
          <ConfirmDialog
            open={confirmSignOut}
            onOpenChange={setConfirmSignOut}
            title="Sign out?"
            description="This computer stops printing Zerox Buddy requests until someone signs in again."
            confirmLabel="Sign out"
            destructive
            onConfirm={signOut}
          />
        </Card>

        <Card>
          <CardHeader title="About" />
          <div className="divide-y px-6 pb-2">
            <Row label="Version" value={state.version} />
          </div>
          <div className="flex items-center justify-between gap-4 px-6 pt-3">
            <p className="text-sm text-muted-foreground">Updates download and install by themselves; Zerox Buddy restarts once done.</p>
            <UpdateCheckButton />
          </div>
          <div className="flex items-center justify-between gap-4 px-6 pb-5 pt-2">
            <p className="max-w-md text-caption font-normal text-muted-foreground">
              Prints with SumatraPDF, included unmodified under the GNU GPLv3 (source: github.com/sumatrapdfreader/sumatrapdf).
            </p>
            <Button variant="ghost" size="sm" onClick={() => void window.zerox.openLogs()}>
              <FolderOpen aria-hidden /> Open logs
            </Button>
          </div>
        </Card>
      </div>
    </>
  );
}
