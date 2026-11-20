"""Makes the Microsoft Store (MSIX) tile images in build/appx/ from build/icon.png.

Run again after the icon changes:  python scripts/make-appx-assets.py
electron-builder picks every file in build/appx/ up by name (.scale-*/.targetsize-*).
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ICON = Image.open(ROOT / "build" / "icon.png").convert("RGBA")
OUT = ROOT / "build" / "appx"
OUT.mkdir(exist_ok=True)

# The icon's own dark green, for the wide tile's background.
BG = ICON.getpixel((ICON.width // 2, ICON.height // 8))


def square(size: int, fill: float) -> Image.Image:
    """The icon centred on a transparent square, taking `fill` of its width."""
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    inner = max(1, round(size * fill))
    icon = ICON.resize((inner, inner), Image.LANCZOS)
    canvas.paste(icon, ((size - inner) // 2, (size - inner) // 2), icon)
    return canvas


def wide(width: int, height: int) -> Image.Image:
    canvas = Image.new("RGBA", (width, height), BG)
    inner = round(height * 0.62)
    icon = ICON.resize((inner, inner), Image.LANCZOS)
    canvas.paste(icon, ((width - inner) // 2, (height - inner) // 2), icon)
    return canvas


for scale in (100, 200):
    k = scale / 100
    square(round(50 * k), 0.9).save(OUT / f"StoreLogo.scale-{scale}.png")
    square(round(44 * k), 0.92).save(OUT / f"Square44x44Logo.scale-{scale}.png")
    square(round(150 * k), 0.66).save(OUT / f"Square150x150Logo.scale-{scale}.png")
    wide(round(310 * k), round(150 * k)).save(OUT / f"Wide310x150Logo.scale-{scale}.png")

# Taskbar / Start list icons drawn without the coloured plate.
for size in (16, 24, 32, 44, 48, 256):
    square(size, 0.92).save(OUT / f"Square44x44Logo.targetsize-{size}_altform-unplated.png")

print("bg", "#%02x%02x%02x" % BG[:3])
print("\n".join(sorted(p.name for p in OUT.iterdir())))
