import * as React from "react";
import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * DESIGN.md §3 Button. Pill-shaped, deep green primary, press = scale .98.
 * `caps` is the priinteve.com CTA voice (Space Mono, uppercase, tracked):
 * for marketing, auth and customer-flow calls to action, not dense dashboard UI.
 */
const buttonVariants = cva(
  "inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-full font-medium outline-none transition-[background-color,box-shadow,transform,color] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-foreground hover:bg-primary-hover",
        lime: "bg-lime text-deep hover:bg-lime-hover",
        secondary: "bg-transparent text-foreground shadow-[inset_0_0_0_1px_hsl(var(--border-strong))] hover:bg-foreground/[0.04]",
        ghost: "text-foreground hover:bg-foreground/[0.05]",
        destructive: "bg-destructive/10 text-destructive hover:bg-destructive/15",
        link: "h-auto px-0 text-foreground underline decoration-border-strong underline-offset-4 hover:decoration-foreground active:scale-100",
      },
      size: {
        sm: "h-8 px-3.5 text-[13px] [&_svg]:size-3.5",
        md: "h-10 px-5 text-sm [&_svg]:size-4",
        lg: "h-12 px-6 text-[15px] [&_svg]:size-[18px]",
        xl: "h-14 px-7 text-base font-semibold [&_svg]:size-5",
        icon: "size-10 [&_svg]:size-[18px]",
        "icon-sm": "size-8 [&_svg]:size-4",
      },
      caps: {
        true: "font-mono font-bold uppercase tracking-[0.12em]",
        false: "",
      },
    },
    compoundVariants: [
      { caps: true, size: "sm", className: "px-4 text-[11px]" },
      { caps: true, size: "md", className: "text-[12px]" },
      { caps: true, size: "lg", className: "px-7 text-[13px]" },
      { caps: true, size: "xl", className: "text-[14px]" },
    ],
    defaultVariants: { variant: "primary", size: "md", caps: false },
  },
);

type ButtonProps = ButtonPrimitive.Props & VariantProps<typeof buttonVariants> & { loading?: boolean };

const Button = React.forwardRef<HTMLElement, ButtonProps>(function Button(
  { className, variant, size, caps, loading, disabled, children, ...props },
  ref,
) {
  return (
    <ButtonPrimitive
      ref={ref}
      className={cn(buttonVariants({ variant, size, caps }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <Loader2 className="animate-spin" aria-hidden />}
      {children}
    </ButtonPrimitive>
  );
});

export { Button, buttonVariants };
