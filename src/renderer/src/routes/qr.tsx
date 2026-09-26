import { Copy, Download, FileImage, FileText, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import type { QrPreview } from "../../../shared/types";
import { Button } from "@/components/ui/button";
import { Card, EmptyState, PageHeader, Skeleton } from "@/components/ui/primitives";
import { run } from "@/lib/app-state";

/**
 * View and download the shop's QR code, in-app. Ported from priinteve-zerox's
 * app/(dashboard)/dashboard/qr/page.tsx, minus the "share link" text field
 * (clipboard copy alone covers it here) and minus Regenerate — that stays a
 * web-only action, since it revokes the printed QR shop-wide immediately and
 * the counter computer is the worst place to offer that as a stray tap.
 */

const DOWNLOADS: { format: "png" | "svg" | "pdf"; label: string; hint: string; icon: typeof FileImage }[] = [
  { format: "png", label: "PNG", hint: "For WhatsApp and screens", icon: FileImage },
  { format: "svg", label: "SVG", hint: "Sharp at any size", icon: FileImage },
  { format: "pdf", label: "PDF poster", hint: "Ready to print on A4", icon: FileText },
];

export function QrScreen() {
  const [state, setState] = useState<{ status: "loading" | "ready" | "error"; data?: QrPreview; message?: string }>({ status: "loading" });
  const [downloading, setDownloading] = useState<"png" | "svg" | "pdf" | null>(null);

  const load = useCallback(async () => {
    setState((s) => ({ status: "loading", data: s.data }));
    try {
      setState({ status: "ready", data: await run(window.zerox.getQr()) });
    } catch (err) {
      setState((s) => ({ status: "error", message: err instanceof Error ? err.message : "Couldn't load this", data: s.data }));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function download(format: "png" | "svg" | "pdf") {
    setDownloading(format);
    try {
      const path = await run(window.zerox.downloadQr(format));
      if (path) toast.success("Saved", { description: path });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save this");
    } finally {
      setDownloading(null);
    }
  }

  async function copyLink() {
    if (!state.data) return;
    try {
      await navigator.clipboard.writeText(state.data.url);
      toast.success("Link copied");
    } catch {
      toast.error("Couldn't copy — try again.");
    }
  }

  if (state.status === "error" && !state.data) {
    return (
      <>
        <PageHeader title="QR code" />
        <Card>
          <EmptyState icon={RefreshCw} title="Couldn't load your QR" description={state.message} action={<Button onClick={() => void load()}>Try again</Button>} />
        </Card>
      </>
    );
  }

  const data = state.data;

  return (
    <>
      <PageHeader title="QR code" description="Customers scan this to upload and print. No app or account needed." />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,360px)_1fr]">
        <Card className="flex flex-col items-center p-8 text-center">
          <p className="text-overline text-muted-foreground">Scan to upload &amp; print</p>
          <div className="mt-6 rounded-3xl bg-card p-4 shadow-lift">
            {data ? (
              <img src={data.pngDataUrl} alt="Your shop's QR code" className="h-auto w-52" />
            ) : (
              <Skeleton className="size-52" />
            )}
          </div>
        </Card>

        <div className="space-y-6">
          <Card className="p-6">
            <h2 className="text-heading">Download</h2>
            <p className="mt-1 text-sm text-muted-foreground">Print the PDF poster for your counter, or share the image.</p>
            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              {DOWNLOADS.map((d) => {
                const Icon = d.icon;
                return (
                  <button
                    key={d.format}
                    type="button"
                    disabled={!data || downloading === d.format}
                    onClick={() => void download(d.format)}
                    className="group flex flex-col rounded-2xl border border-border-strong/60 p-4 text-left transition-shadow hover:shadow-lift disabled:pointer-events-none disabled:opacity-50"
                  >
                    <span className="flex items-center justify-between">
                      <Icon className="size-5 text-foreground" aria-hidden />
                      <Download className="size-4 text-muted-foreground transition-transform group-hover:translate-y-0.5" aria-hidden />
                    </span>
                    <span className="mt-4 text-sm font-semibold">{d.label}</span>
                    <span className="text-caption font-normal text-muted-foreground">{d.hint}</span>
                  </button>
                );
              })}
            </div>
          </Card>

          <Card className="p-6">
            <h2 className="text-heading">Share link</h2>
            <p className="mt-1 text-sm text-muted-foreground">The same page your QR opens, for WhatsApp or your Google profile.</p>
            <div className="mt-4 flex items-center gap-3">
              <code className="min-w-0 flex-1 truncate rounded-xl border border-border-strong/60 bg-card px-3.5 py-2.5 font-mono text-[13px]">
                {data?.url ?? ""}
              </code>
              <Button variant="secondary" onClick={() => void copyLink()} disabled={!data} aria-label="Copy link">
                <Copy aria-hidden /> Copy
              </Button>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
