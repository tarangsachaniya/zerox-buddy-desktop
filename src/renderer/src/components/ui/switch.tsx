"use client";

import { cn } from "@/lib/utils";

/**
 * DESIGN.md §3 Switch: a deep green track when on, muted when off. A real
 * button with role="switch" so keyboard and screen readers get it for free;
 * the label is the visible text beside it (aria-labelledby).
 */
export function Switch({
  checked,
  onChange,
  disabled,
  id,
  labelledBy,
  describedBy,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  id?: string;
  labelledBy?: string;
  describedBy?: string;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : ariaLabel}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-deep" : "bg-border-strong/70",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute left-1 size-5 rounded-full shadow-soft transition-transform duration-200 ease-out",
          checked ? "translate-x-5 bg-lime" : "translate-x-0 bg-card",
        )}
      />
    </button>
  );
}

/** A settings row: title + description on the left, switch on the right. */
export function SwitchRow({
  id,
  title,
  description,
  checked,
  onChange,
  disabled,
}: {
  id: string;
  title: string;
  description: React.ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-6 py-4">
      <div className="min-w-0">
        <p id={`${id}-label`} className="text-[15px] font-medium text-foreground">
          {title}
        </p>
        <p id={`${id}-desc`} className="mt-0.5 text-sm text-muted-foreground">
          {description}
        </p>
      </div>
      <Switch
        id={id}
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        labelledBy={`${id}-label`}
        describedBy={`${id}-desc`}
      />
    </div>
  );
}
