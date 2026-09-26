import { AlertTriangle, DownloadCloud, WifiOff } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import type { UpdaterStatusEvent } from "../../../shared/updater-types";
import { Button } from "@/components/ui/button";

/**
 * Renders what src/main/updater decides, nothing more. Mounted outside the
 * sign-in gate: a required update has to take over the login screen too.
 * Ported from priinteve-owner-desktop's components/updater.
 */

type Progress = { percent: number; transferred: number; total: number };
type Phase = "prompt" | "downloading" | "installing" | "error";
type Mandatory = { latestVersion: string; releaseNotes: string[]; phase: Phase; progress: Progress | null; errorMessage: string | null };
type Optional = { phase: Exclude<Phase, "prompt">; progress: Progress | null; errorMessage: string | null };

const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);

/** No close button, Escape or click-outside: nothing here can dismiss itself. */
function Overlay({ label, icon, children }: { label: string; icon: ReactNode; children: ReactNode }) {
  return (
    <div role="alertdialog" aria-modal="true" aria-label={label} className="fixed inset-0 z-[999] grid place-items-center bg-deep/95 p-6 text-deep-foreground backdrop-blur-sm">
      <div className="flex w-full max-w-md flex-col items-center gap-5 text-center">
        <span className="grid size-14 place-items-center rounded-full bg-lime/15 text-lime">{icon}</span>
        {children}
      </div>
    </div>
  );
}

function ProgressBar({ progress, onCancel }: { progress: Progress | null; onCancel?: () => void }) {
  const pct = Math.max(0, Math.min(100, progress?.percent ?? 0));
  return (
    <div className="flex w-full flex-col gap-3">
      <div className="h-2 w-full overflow-hidden rounded-full bg-white/15">
        <div className="h-full rounded-full bg-lime transition-[width] duration-200" style={{ width: `${pct}%` }} />
      </div>
      <div className="flex justify-between font-mono text-[12px] text-white/70">
        <span>{pct.toFixed(0)}%</span>
        {progress && (
          <span>
            {mb(progress.transferred)} MB / {mb(progress.total)} MB
          </span>
        )}
      </div>
      {onCancel && (
        <Button variant="secondary" className="self-center text-deep-foreground" onClick={onCancel}>
          Cancel
        </Button>
      )}
    </div>
  );
}

export function UpdaterBridge() {
  const [mandatory, setMandatory] = useState<Mandatory | null>(null);
  const [optional, setOptional] = useState<Optional | null>(null);
  const [offlineBlocked, setOfflineBlocked] = useState(false);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    return window.zerox.updater.onStatus((status: UpdaterStatusEvent) => {
      switch (status.state) {
        case "optional-available": {
          const version = status.latestVersion;
          toast.info(`Update available: v${version}`, {
            id: `update-available-${version}`,
            description: status.releaseNotes.slice(0, 3).join(" · ") || "A new version of Zerox Buddy is ready to install.",
            duration: 20_000,
            action: {
              label: "Update now",
              onClick: () => {
                setOptional({ phase: "downloading", progress: null, errorMessage: null });
                void window.zerox.updater.startUpdate();
              },
            },
            cancel: { label: "Later", onClick: () => void window.zerox.updater.dismiss(version) },
          });
          break;
        }
        case "mandatory-required":
          setMandatory({ latestVersion: status.latestVersion, releaseNotes: status.releaseNotes, phase: "prompt", progress: null, errorMessage: null });
          break;
        case "offline-blocked":
          setOfflineBlocked(true);
          setRetrying(false);
          break;
        case "no-update":
        case "check-failed":
          setOfflineBlocked(false);
          setRetrying(false);
          break;
        case "download-progress": {
          const progress = { percent: status.percent, transferred: status.transferred, total: status.total };
          if (status.mandatory) setMandatory((m) => (m ? { ...m, phase: "downloading", progress, errorMessage: null } : m));
          else setOptional({ phase: "downloading", progress, errorMessage: null });
          break;
        }
        case "installing":
          setMandatory((m) => (m ? { ...m, phase: "installing" } : m));
          setOptional((o) => (o ? { ...o, phase: "installing" } : o));
          break;
        case "download-error":
          if (status.willRetry) break;
          setMandatory((m) => (m ? { ...m, phase: "error", errorMessage: status.message } : m));
          setOptional((o) => (o ? { ...o, phase: "error", errorMessage: status.message } : o));
          break;
        case "error":
          setMandatory((m) => (m ? { ...m, phase: "error", errorMessage: status.message } : m));
          setOptional((o) => (o ? { ...o, phase: "error", errorMessage: status.message } : o));
          break;
        case "cancelled":
          setOptional(null);
          break;
        case "restored-after-failure":
          toast.warning("An update didn't install cleanly, so your previous version was restored", {
            description: status.toVersion
              ? `Zerox Buddy is back on v${status.fromVersion ?? "the previous version"} after v${status.toVersion} failed to start.`
              : undefined,
            duration: 30_000,
          });
          break;
        default:
          break;
      }
    });
  }, []);

  function startMandatory() {
    setMandatory((m) => (m ? { ...m, phase: "downloading", errorMessage: null } : m));
    void window.zerox.updater.startUpdate();
  }

  if (mandatory) {
    return (
      <Overlay label="Update required" icon={<AlertTriangle className="size-7" aria-hidden />}>
        <div className="flex flex-col gap-2">
          <h1 className="font-display text-2xl font-bold tracking-[-0.02em]">Update required</h1>
          <p className="text-sm text-white/70">Zerox Buddy v{mandatory.latestVersion} must be installed before printing can continue.</p>
        </div>
        {mandatory.phase === "prompt" && mandatory.releaseNotes.length > 0 && (
          <ul className="w-full list-disc space-y-1 rounded-2xl bg-white/5 p-4 pl-8 text-left text-sm text-white/70">
            {mandatory.releaseNotes.slice(0, 6).map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
        )}
        {mandatory.phase === "prompt" && (
          <Button variant="lime" size="lg" onClick={startMandatory}>
            Update now
          </Button>
        )}
        {mandatory.phase === "downloading" && <ProgressBar progress={mandatory.progress} />}
        {mandatory.phase === "installing" && <p className="text-sm text-white/70">Installing. Zerox Buddy will restart by itself…</p>}
        {mandatory.phase === "error" && (
          <>
            <p className="text-sm text-red-300">{mandatory.errorMessage ?? "The update failed."}</p>
            <Button variant="lime" size="lg" onClick={startMandatory}>
              Try again
            </Button>
          </>
        )}
      </Overlay>
    );
  }

  if (offlineBlocked) {
    return (
      <Overlay label="Connect to the internet to continue" icon={<WifiOff className="size-7" aria-hidden />}>
        <div className="flex flex-col gap-2">
          <h1 className="font-display text-2xl font-bold tracking-[-0.02em]">Connect to the internet</h1>
          <p className="text-sm text-white/70">This version of Zerox Buddy needs a required update, and this computer is offline right now.</p>
        </div>
        <Button
          variant="lime"
          size="lg"
          loading={retrying}
          onClick={() => {
            setRetrying(true);
            void window.zerox.updater.check();
          }}
        >
          Try again
        </Button>
      </Overlay>
    );
  }

  if (optional) {
    const cancel = () => {
      void window.zerox.updater.cancelDownload();
      setOptional(null);
    };
    return (
      <Overlay label="Downloading update" icon={<DownloadCloud className="size-7" aria-hidden />}>
        <h1 className="font-display text-2xl font-bold tracking-[-0.02em]">{optional.phase === "installing" ? "Installing update" : "Downloading update"}</h1>
        {optional.phase === "installing" && <p className="text-sm text-white/70">Zerox Buddy will restart by itself…</p>}
        {optional.phase === "downloading" && <ProgressBar progress={optional.progress} onCancel={cancel} />}
        {optional.phase === "error" && (
          <>
            <p className="text-sm text-red-300">{optional.errorMessage ?? "The download failed."}</p>
            <div className="flex gap-2">
              <Button variant="secondary" className="text-deep-foreground" onClick={cancel}>
                Dismiss
              </Button>
              <Button
                variant="lime"
                onClick={() => {
                  setOptional({ phase: "downloading", progress: null, errorMessage: null });
                  void window.zerox.updater.startUpdate();
                }}
              >
                Try again
              </Button>
            </div>
          </>
        )}
      </Overlay>
    );
  }

  return null;
}
