import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

/**
 * Semantic token names only. Values live in app/globals.css, rationale in
 * DESIGN.md. Components must use these names, never raw colours.
 */
const token = (name: string) => `hsl(var(--${name}) / <alpha-value>)`;

const config: Config = {
  darkMode: ["class"],
  content: ["./src/renderer/index.html", "./src/renderer/src/**/*.{ts,tsx}"],
  theme: {
    container: { center: true, padding: "1.25rem", screens: { "2xl": "1240px" } },
    extend: {
      colors: {
        background: token("background"),
        foreground: token("foreground"),
        strong: token("display"),
        card: { DEFAULT: token("card"), foreground: token("card-foreground") },
        muted: { DEFAULT: token("muted"), foreground: token("muted-foreground") },
        subtle: token("subtle"),
        border: { DEFAULT: token("border"), strong: token("border-strong") },
        input: token("input"),
        ring: token("ring"),
        primary: { DEFAULT: token("primary"), hover: token("primary-hover"), foreground: token("primary-foreground") },
        accent: { DEFAULT: token("accent"), foreground: token("accent-foreground") },
        lime: { DEFAULT: token("lime"), hover: token("lime-hover") },
        note: token("note-bg"),
        deep: { DEFAULT: token("deep-bg"), foreground: token("deep-fg") },
        destructive: { DEFAULT: token("destructive"), foreground: token("destructive-foreground") },
        success: { DEFAULT: token("success"), foreground: token("success-foreground") },
        warning: { DEFAULT: token("warning"), foreground: token("warning-foreground") },
        info: { DEFAULT: token("info"), foreground: token("info-foreground") },
      },
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "Segoe UI", "sans-serif"],
        display: ["var(--font-display)", "var(--font-sans)", "ui-sans-serif", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
        hand: ["var(--font-hand)", "cursive"],
      },
      fontSize: {
        "display-xl": ["4.75rem", { lineHeight: "1", letterSpacing: "-0.05em", fontWeight: "800" }],
        display: ["3.25rem", { lineHeight: "1.02", letterSpacing: "-0.045em", fontWeight: "800" }],
        title: ["2rem", { lineHeight: "1.1", letterSpacing: "-0.035em", fontWeight: "700" }],
        heading: ["1.3125rem", { lineHeight: "1.3", letterSpacing: "-0.02em", fontWeight: "700" }],
        "body-lg": ["1.0625rem", { lineHeight: "1.7" }],
        caption: ["0.8125rem", { lineHeight: "1.125rem", fontWeight: "500" }],
        overline: ["0.6875rem", { lineHeight: "1rem", letterSpacing: "0.14em", fontWeight: "400" }],
        specimen: ["3.5rem", { lineHeight: "3.5rem", letterSpacing: "-0.02em", fontWeight: "700" }],
      },
      borderRadius: {
        lg: "var(--radius)",
        xl: "12px",
        "2xl": "16px",
        "3xl": "24px",
      },
      boxShadow: {
        hairline: "0 0 0 1px hsl(var(--border))",
        soft: "0 0 0 1px hsl(var(--border)), 0 1px 2px hsl(var(--ink) / 0.04), 0 1px 3px hsl(var(--ink) / 0.05)",
        lift: "0 0 0 1px hsl(var(--border)), 0 8px 24px -4px hsl(var(--ink) / 0.1), 0 2px 8px -2px hsl(var(--ink) / 0.06)",
        float: "0 0 0 1px hsl(var(--border)), 0 24px 64px -28px hsl(var(--ink) / 0.25), 0 2px 8px -2px hsl(var(--ink) / 0.06)",
      },
      transitionTimingFunction: { out: "var(--ease-out)" },
      keyframes: {
        "fade-up": { from: { opacity: "0", transform: "translateY(16px)" }, to: { opacity: "1", transform: "none" } },
        pulse_dot: { "0%,100%": { opacity: "1" }, "50%": { opacity: "0.25" } },
        marquee: { from: { transform: "translateX(0)" }, to: { transform: "translateX(-50%)" } },
        float: { "0%,100%": { transform: "translateY(0) rotate(var(--tilt, 0deg))" }, "50%": { transform: "translateY(-8px) rotate(var(--tilt, 0deg))" } },
      },
      animation: {
        "fade-up": "fade-up var(--duration-slow) var(--ease-out) both",
        "pulse-dot": "pulse_dot 1.6s ease-in-out infinite",
        marquee: "marquee 40s linear infinite",
        float: "float 7s ease-in-out infinite",
      },
    },
  },
  plugins: [animate],
};

export default config;
