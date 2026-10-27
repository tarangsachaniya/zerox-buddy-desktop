import type { SheetLayout } from "../../../../shared/passport/layout";

/**
 * A proportional drawing of one sheet: the paper, its printable area, and
 * every photo with its cut-out border. Drawn in millimetres (the SVG's
 * viewBox), so it's the same layout the PDF uses, only scaled to fit; the
 * label under it says so.
 */
export function SheetPreview({
  layout,
  page,
  photoUrl,
  border,
}: {
  layout: SheetLayout;
  page: number;
  photoUrl: string | null;
  border: { enabled: boolean; thicknessMm: number };
}) {
  const { paper, printable } = layout;
  const cells = layout.pages[page] ?? [];
  if (!(paper.widthMm > 0) || !(paper.heightMm > 0)) return null;
  // Thin lines stay visible at screen size; the real border prints at its real thickness.
  const borderDraw = Math.max(border.thicknessMm, 0.35);
  return (
    <svg
      viewBox={`0 0 ${paper.widthMm} ${paper.heightMm}`}
      className="h-full max-h-[58dvh] w-auto max-w-full rounded-sm bg-white shadow-lift"
      role="img"
      aria-label={`Sheet ${page + 1}: ${cells.length} photos on ${paper.widthMm} × ${paper.heightMm} mm paper`}
    >
      <rect
        x={printable.x}
        y={printable.y}
        width={Math.max(0, printable.w)}
        height={Math.max(0, printable.h)}
        fill="none"
        stroke="hsl(var(--primary))"
        strokeOpacity={0.35}
        strokeWidth={0.4}
        strokeDasharray="2 1.5"
      />
      {cells.map((c, i) => (
        <g key={i}>
          {photoUrl ? (
            <image href={photoUrl} x={c.x} y={c.y} width={c.w} height={c.h} preserveAspectRatio="none" />
          ) : (
            <rect x={c.x} y={c.y} width={c.w} height={c.h} fill="hsl(var(--muted))" />
          )}
          {border.enabled && (
            <rect
              x={c.x + borderDraw / 2}
              y={c.y + borderDraw / 2}
              width={c.w - borderDraw}
              height={c.h - borderDraw}
              fill="none"
              stroke="#000"
              strokeWidth={borderDraw}
            />
          )}
        </g>
      ))}
    </svg>
  );
}
