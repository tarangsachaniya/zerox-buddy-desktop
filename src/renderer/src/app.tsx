import { CreditCard, IndianRupee, ListOrdered, Power, Printer, QrCode, ScanLine, Settings, SquareUser } from "lucide-react";
import { useState } from "react";
import { HashRouter, NavLink, Navigate, Route, Routes } from "react-router-dom";
import { Toaster, toast } from "sonner";

import { IncomingPhotoPopup } from "@/components/incoming-photo-popup";
import { ManualDuplexModal } from "@/components/manual-duplex-modal";
import { Button } from "@/components/ui/button";
import { Badge, Logo } from "@/components/ui/primitives";
import { UpdaterBridge } from "@/components/updater";
import { AppStateProvider, run, useAppState } from "@/lib/app-state";
import { cn } from "@/lib/utils";
import { LoginScreen } from "@/routes/login";
import { PassportScreen } from "@/routes/passport";
import { PricingScreen } from "@/routes/pricing";
import { PrintersScreen } from "@/routes/printers";
import { QrScreen } from "@/routes/qr";
import { QueueScreen } from "@/routes/queue";
import { ScanScreen } from "@/routes/scan";
import { SettingsScreen } from "@/routes/settings";
import { SubscriptionScreen } from "@/routes/subscription";

const NAV = [
  { to: "/", label: "Print queue", icon: ListOrdered },
  { to: "/scan", label: "Scan & copy", icon: ScanLine },
  { to: "/passport", label: "Passport photos", icon: SquareUser },
  { to: "/printers", label: "Printers", icon: Printer },
  { to: "/pricing", label: "Pricing", icon: IndianRupee },
  { to: "/qr", label: "QR code", icon: QrCode },
  { to: "/subscription", label: "Subscription", icon: CreditCard },
  { to: "/settings", label: "Settings", icon: Settings },
];

function Shell() {
  const state = useAppState()!;
  const waiting = state.queue.waiting.length;
  // Scan & copy appears once the plan includes it.
  const canScan = !!(state.entitlements?.features.scan || state.entitlements?.features.photocopy);
  const canPassport = !!state.entitlements?.features.passport_photo;
  const incoming = state.incomingPhotos.filter((p) => p.status === "READY").length;
  // The server link only; a printer that's off shows on the printer, not here.
  const connection =
    state.connection === "online"
      ? { tone: "success" as const, label: "Online", pulse: true, hint: "Connected to Zerox Buddy" }
      : state.connection === "connecting"
        ? { tone: "warning" as const, label: "Connecting", hint: "Connecting to Zerox Buddy…" }
        : state.connection === "reconnecting"
          ? { tone: "warning" as const, label: "Reconnecting", hint: "Lost the connection for a moment; reconnecting" }
          : {
              tone: "danger" as const,
              label: "Offline",
              hint:
                state.connectionReason === "server"
                  ? "The Zerox Buddy server isn't answering. Retrying; printing from this PC still works."
                  : state.connectionReason === "auth"
                    ? "Sign-in needs renewing. Retrying."
                    : "No internet connection. Retrying; printing from this PC still works.",
            };

  return (
    <div className="grid h-dvh grid-cols-[232px_1fr]">
      <aside className="flex flex-col border-r border-border-strong/50 bg-subtle px-3 py-4">
        <div className="px-2.5 py-1">
          <Logo />
        </div>
        <div className="mt-5 rounded-2xl border border-border-strong/60 bg-card px-3.5 py-3">
          <p className="truncate font-display text-[15px] font-bold tracking-[-0.02em]">{state.shop?.shopName ?? "Loading…"}</p>
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <span className="font-mono text-[11px] text-muted-foreground">{state.shop?.shopCode}</span>
            <span title={connection.hint}>
              <Badge tone={connection.tone} pulse={connection.pulse}>
                {connection.label}
              </Badge>
            </span>
          </div>
          {state.shop && <ShopOpenButton open={!!state.shop.isOpen} />}
        </div>
        <nav className="mt-5 flex flex-col gap-0.5" aria-label="Main">
          {NAV.filter((n) => (n.to !== "/scan" || canScan) && (n.to !== "/passport" || canPassport)).map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === "/"}
              className={({ isActive }) =>
                cn(
                  "flex h-9 items-center gap-2.5 rounded-full px-3 text-sm transition-colors",
                  isActive ? "bg-lime font-semibold text-deep" : "text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground",
                )
              }
            >
              <n.icon className="size-4" aria-hidden />
              {n.label}
              {n.to === "/" && waiting > 0 && (
                <span className="ml-auto rounded-full bg-deep px-2 py-0.5 font-mono text-[10px] font-bold text-deep-foreground">{waiting}</span>
              )}
              {n.to === "/passport" && incoming > 0 && (
                <span className="ml-auto rounded-full bg-deep px-2 py-0.5 font-mono text-[10px] font-bold text-deep-foreground">{incoming}</span>
              )}
            </NavLink>
          ))}
        </nav>
        <p className="mt-auto px-2.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
          Zerox Buddy Desktop {state.version}
        </p>
      </aside>
      <main className="min-w-0 overflow-y-auto px-8 py-8">
        <div className="mx-auto max-w-[1000px]">
          <Routes>
            <Route path="/" element={<QueueScreen />} />
            <Route path="/scan" element={<ScanScreen />} />
            <Route path="/passport" element={<PassportScreen />} />
            <Route path="/printers" element={<PrintersScreen />} />
            <Route path="/pricing" element={<PricingScreen />} />
            <Route path="/qr" element={<QrScreen />} />
            <Route path="/subscription" element={<SubscriptionScreen />} />
            <Route path="/settings" element={<SettingsScreen />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}

/** Online uploads only while the counter has started; until then customers see "Shop is closed". */
function ShopOpenButton({ open }: { open: boolean }) {
  const [busy, setBusy] = useState(false);
  async function toggle() {
    setBusy(true);
    try {
      await run(window.zerox.setShopOpen(!open));
      toast.success(open ? "Shop closed" : "Zerox Buddy started", {
        description: open ? "Customers scanning your QR now see that the shop is closed." : "Customers can send prints and photos now.",
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't change this. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-3 border-t border-border-strong/40 pt-3">
      <p className="mb-2 text-[12px] text-muted-foreground">{open ? "Open: taking uploads from your QR" : "Closed: your QR shows “Shop is closed”"}</p>
      <Button size="sm" variant={open ? "secondary" : "lime"} className="w-full" loading={busy} onClick={() => void toggle()}>
        {!busy && <Power aria-hidden />} {open ? "Close shop" : "Start Zerox Buddy"}
      </Button>
    </div>
  );
}

function Root() {
  const state = useAppState();
  if (!state) return <div className="h-dvh" />;
  return state.signedIn ? (
    <>
      <Shell />
      <ManualDuplexModal />
      <IncomingPhotoPopup />
    </>
  ) : (
    <LoginScreen />
  );
}

export function App() {
  return (
    <AppStateProvider>
      <HashRouter>
        <Root />
      </HashRouter>
      <UpdaterBridge />
      <Toaster
        position="bottom-right"
        toastOptions={{
          classNames: {
            toast: "!rounded-2xl !border-0 !shadow-lift !bg-card !text-foreground !font-sans",
            description: "!text-muted-foreground",
          },
        }}
      />
    </AppStateProvider>
  );
}
