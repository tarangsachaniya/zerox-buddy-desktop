import { ExternalLink, FolderOpen, LogOut } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
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

export function SettingsScreen() {
  const state = useAppState()!;
  const shop = state.shop;
  const [signingOut, setSigningOut] = useState(false);
  const on = (v: boolean | undefined) => (v ? "On" : "Off");

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

        <Card>
          <CardHeader
            title="Printing"
            description="Set for the whole shop on the web dashboard."
            action={
              <Button variant="secondary" size="sm" onClick={() => void window.zerox.openWebDashboard("/settings")}>
                Change <ExternalLink aria-hidden />
              </Button>
            }
          />
          <div className="divide-y px-6 pb-2">
            <Row label="Print automatically" value={on(shop?.autoPrint)} />
            <Row label="Choose the printer automatically" value={on(shop?.autoRouting)} />
            <Row label="Preview before printing" value={on(shop?.requirePreview)} />
            <Row label="Delete files after printing" value={on(shop?.autoDeleteFiles)} />
          </div>
        </Card>

        <Card>
          <CardHeader title="Account" />
          <div className="divide-y px-6 pb-2">
            <Row label="Shop" value={shop ? `${shop.shopName} · ${shop.shopCode}` : "…"} />
            <Row label="Plan" value={state.entitlements ? state.entitlements.planName + (state.entitlements.trialEndsAt ? " (trial)" : "") : "…"} />
          </div>
          <div className="flex justify-end px-6 pb-5 pt-2">
            <Button
              variant="secondary"
              loading={signingOut}
              onClick={async () => {
                if (!window.confirm("Sign out? This computer stops printing Zerox Buddy requests until someone signs in again.")) return;
                setSigningOut(true);
                await window.zerox.logout();
              }}
            >
              {!signingOut && <LogOut aria-hidden />} Sign out
            </Button>
          </div>
        </Card>

        <Card>
          <CardHeader title="About" />
          <div className="divide-y px-6 pb-2">
            <Row label="Version" value={state.version} />
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
