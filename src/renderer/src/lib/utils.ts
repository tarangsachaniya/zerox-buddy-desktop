import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge only knows Tailwind's default scale. Without this, a custom
 * type-scale class such as `text-caption` is mistaken for a colour and dropped
 * whenever it meets `text-muted-foreground` — silently losing the font size.
 * Keep in step with fontSize and the semantic colours in tailwind.config.ts.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["display-xl", "display", "title", "heading", "body-lg", "caption", "overline", "specimen"] }],
      "text-color": [{ text: ["strong", "lime", "note", "deep", "deep-foreground"] }],
      "font-family": [{ font: ["display", "hand"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
