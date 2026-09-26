import { AlertTriangle, ArrowUpRight, Check, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { Features, OwnerSubscription, Plan } from "../../../shared/types";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge, Card, CardHeader, EmptyState, PageHeader, Skeleton } from "@/components/ui/primitives";
import { run } from "@/lib/app-state";
import { cn } from "@/lib/utils";

/**
 * The in-app plan/usage screen, ported from priinteve-zerox's
 * app/(dashboard)/dashboard/subscription/page.tsx. "Upgrade or renew" stays
 * an EXTERNAL link to Priinteve's own contact page — that's not the Zerox
 * Buddy web dashboard, and it stays external because there is no self-serve
 * checkout anywhere to embed instead (plans are admin-activated).
 */
const CONTACT_URL = "https://priinteve.com/contact";

const FEATURE_ROWS: { key: Exclude<keyof Features, "monthly_job_limit">; label: string }[] = [
  { key: "color", label: "Color printing" },
  { key: "a3", label: "A3 paper" },
  { key: "duplex", label: "Double-sided" },
  { key: "smart_routing", label: "Smart printer routing" },
  { key: "passport_photo", label: "Passport photo sheets" },
  { key: "print_preview", label: "Print preview" },
  { key: "reports", label: "Reports" },
  { key: "printer_monitoring", label: "Printer monitoring" },
];

function rupees(n: number): string {
  return `₹${n.toLocaleString("en-IN", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—";
}

function Meter({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const near = limit !== null && pct >= 80;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-sm tabular-nums text-muted-foreground">
          <span className="font-display text-lg font-bold text-foreground">{used.toLocaleString("en-IN")}</span>
          {limit === null ? " · Unlimited" : ` of ${limit.toLocaleString("en-IN")}`}
        </p>
      </div>
      <div
        className="mt-2 h-2.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={label}
        aria-valuenow={used}
        aria-valuemin={0}
        aria-valuemax={limit ?? undefined}
      >
        {limit !== null && <div className={cn("h-full rounded-full", near ? "bg-warning" : "bg-deep")} style={{ width: `${pct}%` }} />}
      </div>
    </div>
  );
}

type Loaded = { subscription: OwnerSubscription; plans: Plan[] };

export function SubscriptionScreen() {
  const [state, setState] = useState<{ status: "loading" | "ready" | "error"; data?: Loaded; message?: string }>({ status: "loading" });

  const load = useCallback(async () => {
    setState((s) => ({ status: "loading", data: s.data }));
    try {
      setState({ status: "ready", data: await run(window.zerox.getSubscription()) });
    } catch (err) {
      setState((s) => ({ status: "error", message: err instanceof Error ? err.message : "Couldn't load this", data: s.data }));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const data = state.data?.subscription;
  const plans = state.data?.plans;

  if (state.status === "error" && !data) {
    return (
      <>
        <PageHeader title="Subscription" />
        <Card>
          <EmptyState icon={RefreshCw} title="Couldn't load your plan" description={state.message} action={<Button onClick={() => void load()}>Try again</Button>} />
        </Card>
      </>
    );
  }

  const sub = data?.subscription;
  const lapsed = data?.isFallback && sub;

  return (
    <>
      <PageHeader
        title="Subscription"
        description="Your plan, what it includes, and how much of it you've used this month."
        actions={
          <a href={CONTACT_URL} target="_blank" rel="noreferrer" className={cn(buttonVariants())}>
            Upgrade or renew <ArrowUpRight aria-hidden />
          </a>
        }
      />

      {lapsed && (
        <div role="status" className="mb-6 flex items-start gap-3 rounded-2xl bg-warning/10 p-5 text-warning-foreground">
          <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden />
          <div className="text-sm">
            <p className="font-semibold">
              Your {sub.planName} plan {sub.status === "SUSPENDED" ? "is paused" : "has ended"}
              {sub.expiresAt ? ` (${formatDate(sub.expiresAt)})` : ""}.
            </p>
            <p className="mt-0.5">Your shop is on the Free plan until it&apos;s renewed. Contact Priinteve to renew.</p>
          </div>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1.1fr_1fr]">
        <Card className="overflow-hidden border-0 bg-deep text-deep-foreground">
          <div className="p-7">
            {!data ? (
              <Skeleton className="h-40 rounded-xl opacity-20" />
            ) : (
              <>
                <p className="text-overline text-lime">Current plan</p>
                <div className="mt-3 flex flex-wrap items-baseline justify-between gap-3">
                  <h2 className="text-display text-deep-foreground">
                    {data.plan.name}
                    {data.trialEndsAt && <span className="ml-3 align-middle font-mono text-sm font-bold uppercase tracking-[0.12em] text-lime">Trial</span>}
                  </h2>
                  <p className="font-mono text-sm uppercase tracking-[0.12em] text-deep-foreground/70">
                    <span className="font-display text-3xl font-extrabold normal-case tracking-[-0.04em] text-deep-foreground">
                      {rupees(data.plan.priceMonthly)}
                    </span>{" "}
                    / {data.trialEndsAt ? "7 days" : "month"}
                  </p>
                </div>
                {data.plan.description && <p className="mt-2 max-w-md text-sm text-deep-foreground/70">{data.plan.description}</p>}
                <dl className="mt-6 grid grid-cols-2 gap-4 border-t border-deep-foreground/15 pt-5 text-sm">
                  <div>
                    <dt className="text-deep-foreground/60">{data.trialEndsAt ? "Free trial" : data.expiresAt ? "Renews or ends" : "Expiry"}</dt>
                    <dd className={cn("mt-0.5 font-medium", data.trialExpired && "text-lime")}>
                      {data.trialEndsAt
                        ? `${data.trialExpired ? "Ended" : "Ends"} ${formatDate(data.trialEndsAt)}`
                        : data.expiresAt
                          ? formatDate(data.expiresAt)
                          : "Never"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-deep-foreground/60">Printers</dt>
                    <dd className="mt-0.5 font-medium">Up to {data.plan.printerLimit}</dd>
                  </div>
                </dl>
                <ul className="mt-6 grid gap-2 text-sm sm:grid-cols-2">
                  {FEATURE_ROWS.map((f) => {
                    const on = data.plan.features[f.key];
                    return (
                      <li key={f.key} className={cn("flex items-center gap-2", !on && "text-deep-foreground/45")}>
                        {on ? <Check className="size-4 text-lime" aria-hidden /> : <X className="size-4" aria-hidden />}
                        <span>
                          {f.label}
                          <span className="sr-only">{on ? " (included)" : " (not included)"}</span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="This month" description="Resets on the 1st (IST)." />
          <div className="grid gap-6 p-6">
            {!data ? (
              <>
                <Skeleton className="h-10 rounded-xl" />
                <Skeleton className="h-10 rounded-xl" />
              </>
            ) : (
              <>
                <Meter label="Online orders" used={data.usage.jobsThisMonth} limit={data.usage.jobLimit} />
                <Meter label="Printers connected" used={data.usage.printers} limit={data.usage.printerLimit} />
                {data.usage.jobLimit !== null && data.usage.jobsThisMonth >= data.usage.jobLimit && (
                  <p className="rounded-xl bg-warning/10 px-3.5 py-2.5 text-sm text-warning-foreground">
                    You&apos;ve reached this month&apos;s limit, so customers are asked to hand files in at the counter. Upgrade to keep taking
                    online orders.
                  </p>
                )}
              </>
            )}
          </div>
        </Card>
      </div>

      <section className="mt-10">
        <h2 className="text-heading">All plans</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Plans are activated by the Priinteve team. Pick one and{" "}
          <a href={CONTACT_URL} target="_blank" rel="noreferrer" className="font-medium text-foreground underline decoration-lime decoration-2 underline-offset-4">
            contact us
          </a>
          .
        </p>
        <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {!plans
            ? [0, 1].map((i) => <Skeleton key={i} className="h-40 rounded-2xl" />)
            : plans.map((p) => {
                const current = p.code === data?.plan.code;
                return (
                  <Card key={p.code} className={cn("p-6", current && "ring-2 ring-deep")}>
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="text-heading">{p.name}</h3>
                      {current && <Badge tone="accent">Current</Badge>}
                    </div>
                    <p className="mt-2 font-display text-title tabular-nums">
                      {rupees(p.priceMonthly)}
                      <span className="ml-1 font-mono text-[12px] font-normal uppercase tracking-[0.12em] text-muted-foreground">/ month</span>
                    </p>
                    <p className="mt-2 text-sm text-muted-foreground">
                      Up to {p.printerLimit} {p.printerLimit === 1 ? "printer" : "printers"} ·{" "}
                      {p.features.monthly_job_limit === null ? "unlimited orders" : `${p.features.monthly_job_limit.toLocaleString("en-IN")} orders a month`}
                    </p>
                    <p className="mt-3 text-sm">{FEATURE_ROWS.filter((f) => p.features[f.key]).map((f) => f.label).join(" · ") || "Black & white A4 printing"}</p>
                  </Card>
                );
              })}
        </div>
      </section>
    </>
  );
}
