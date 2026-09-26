import * as React from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/** DESIGN.md §3 Card — hairline at rest, never nested. */
export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-2xl bg-card text-card-foreground shadow-hairline", className)} {...props} />;
}

export function CardHeader({
  title,
  description,
  action,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-4 px-6 pt-5", className)}>
      <div className="min-w-0">
        <h2 className="text-heading">{title}</h2>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}

type Tone = "neutral" | "warning" | "info" | "success" | "danger" | "accent";

const TONE: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground [--dot:hsl(var(--line-strong))]",
  warning: "bg-warning/10 text-warning-foreground [--dot:hsl(var(--warning))]",
  info: "bg-info/10 text-info-foreground [--dot:hsl(var(--info))]",
  success: "bg-success/10 text-success-foreground [--dot:hsl(var(--success))]",
  danger: "bg-destructive/10 text-destructive [--dot:hsl(var(--destructive))]",
  accent: "bg-lime text-deep [--dot:hsl(var(--deep))]",
};

/** Dot + label; status is never colour alone (DESIGN.md §6). */
export function Badge({
  tone = "neutral",
  dot = true,
  pulse,
  className,
  children,
}: {
  tone?: Tone;
  dot?: boolean;
  pulse?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-caption",
        TONE[tone],
        className,
      )}
    >
      {dot && <span aria-hidden className={cn("size-1.5 rounded-full bg-[var(--dot)]", pulse && "animate-pulse-dot")} />}
      {children}
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("skeleton", className)} />;
}

/** DESIGN.md §3 Empty state — icon, heading, one sentence, at most one action. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-14 text-center", className)}>
      <span className="grid size-12 place-items-center rounded-full bg-accent text-accent-foreground">
        <Icon className="size-[22px]" aria-hidden />
      </span>
      <h3 className="mt-4 text-heading">{title}</h3>
      <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">{description}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 pb-6 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-title">{title}</h1>
        {description && <p className="mt-1 text-[15px] text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Mono uppercase eyebrow above a heading, as on priinteve.com. */
export function Eyebrow({ className, children }: { className?: string; children: React.ReactNode }) {
  return <p className={cn("text-overline text-muted-foreground", className)}>{children}</p>;
}

export function Logo({ className, onDark }: { className?: string; onDark?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 font-display text-[17px] font-bold tracking-[-0.03em]",
        onDark ? "text-deep-foreground" : "text-strong",
        className,
      )}
    >
      <svg viewBox="0 0 28 28" className="size-7" aria-hidden>
        <rect width="28" height="28" rx="8" fill={onDark ? "hsl(var(--acid))" : "hsl(var(--deep))"} />
        <path
          d="M8.5 9.5h11l-11 9h11"
          fill="none"
          stroke={onDark ? "hsl(var(--deep))" : "hsl(var(--acid))"}
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span>
        Zerox <span className={cn("font-semibold", onDark ? "text-deep-foreground/60" : "text-muted-foreground")}>Buddy</span>
      </span>
    </span>
  );
}
